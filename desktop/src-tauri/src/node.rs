//! Buscar `node` (≥ 24) y `claude` con el PATH que va a ver el server.

use std::ffi::OsStr;
use std::fmt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::login_env::run_limited;

pub const MIN_MAJOR: u64 = 24;
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

pub type Version = (u64, u64, u64);

/// `v24.21.0`, `24.2`, `v25.0.0-nightly2026…` → (mayor, menor, parche).
pub fn parse_version(s: &str) -> Option<Version> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let core = s.split(['-', '+', ' ']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let major = parts.next()??;
    let minor = parts.next().unwrap_or(Some(0))?;
    let patch = parts.next().unwrap_or(Some(0))?;
    Some((major, minor, patch))
}

fn show(v: Version) -> String {
    format!("v{}.{}.{}", v.0, v.1, v.2)
}

fn is_executable(p: &Path) -> bool {
    p.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Busca un ejecutable en un PATH (solo entradas absolutas).
pub fn which(name: &str, path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(name))
        .find(|p| is_executable(p))
}

/// De dónde salió el node que se usa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeSource {
    Settings,
    EnvVar,
    Path,
}

impl fmt::Display for NodeSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Settings => "los ajustes de la app",
            Self::EnvVar => "CONTROL_PLANE_NODE",
            Self::Path => "el PATH",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeInfo {
    pub path: PathBuf,
    pub version: Version,
    pub source: NodeSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeError {
    /// No hay `node` en el PATH combinado.
    NotFound {
        shell: PathBuf,
        dirs: usize,
    },
    /// La ruta elegida (ajustes o CONTROL_PLANE_NODE) no existe o no es ejecutable.
    Missing {
        path: PathBuf,
        source: NodeSource,
    },
    /// `node --version` falló, tardó demasiado o respondió algo que no es una versión.
    Broken {
        path: PathBuf,
        detail: String,
    },
    TooOld {
        path: PathBuf,
        version: Version,
    },
}

impl fmt::Display for NodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { shell, dirs } => write!(
                f,
                "No encontré node. Lo busqué en las {dirs} carpetas del PATH de tu shell de login ({}) \
                 y en las rutas de siempre. Instalá Node {MIN_MAJOR} o más nuevo, o elegí cuál usar en los ajustes.",
                shell.display()
            ),
            Self::Missing { path, source } => write!(
                f,
                "El node que elegiste en {source} ({}) no existe o no se puede ejecutar.",
                path.display()
            ),
            Self::Broken { path, detail } => {
                write!(f, "No pude preguntarle la versión a {} ({detail}).", path.display())
            }
            Self::TooOld { path, version } => write!(
                f,
                "Necesitás Node {MIN_MAJOR} o más nuevo, y encontré {} en {}. \
                 Actualizalo o elegí otro en los ajustes.",
                show(*version),
                path.display()
            ),
        }
    }
}

/// El node a usar: el de los ajustes, si no `CONTROL_PLANE_NODE`, si no el del PATH combinado.
/// Una ruta elegida a mano que no sirve es un error (no se cambia por otra en silencio).
pub fn find_node(
    settings_path: Option<&Path>,
    env_node: Option<&str>,
    path: &OsStr,
    shell: &Path,
) -> Result<NodeInfo, NodeError> {
    let chosen = settings_path
        .map(|p| (p.to_path_buf(), NodeSource::Settings))
        .or_else(|| {
            env_node
                .filter(|s| !s.is_empty())
                .map(|s| (PathBuf::from(s), NodeSource::EnvVar))
        });
    // Un nombre suelto en CONTROL_PLANE_NODE (p. ej. `node24`) se busca en el PATH, como CLAUDE_BIN.
    let chosen = chosen.map(|(p, source)| match source {
        NodeSource::EnvVar if p.components().count() == 1 && !p.is_absolute() => {
            (which(&p.to_string_lossy(), path).unwrap_or(p), source)
        }
        _ => (p, source),
    });
    let (bin, source) = match chosen {
        Some((p, source)) if p.is_absolute() && is_executable(&p) => (p, source),
        Some((path, source)) => return Err(NodeError::Missing { path, source }),
        None => match which("node", path) {
            Some(p) => (p, NodeSource::Path),
            None => {
                return Err(NodeError::NotFound {
                    shell: shell.to_path_buf(),
                    dirs: std::env::split_paths(path).count(),
                })
            }
        },
    };
    let version = node_version(&bin)?;
    if version.0 < MIN_MAJOR {
        return Err(NodeError::TooOld { path: bin, version });
    }
    Ok(NodeInfo {
        path: bin,
        version,
        source,
    })
}

fn node_version(bin: &Path) -> Result<Version, NodeError> {
    let broken = |detail: String| NodeError::Broken {
        path: bin.to_path_buf(),
        detail,
    };
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    let run = run_limited(cmd, VERSION_TIMEOUT, None).map_err(|e| broken(e.to_string()))?;
    if run.timed_out {
        return Err(broken(format!(
            "no respondió en {} s",
            VERSION_TIMEOUT.as_secs()
        )));
    }
    let out = String::from_utf8_lossy(&run.stdout);
    parse_version(&out).ok_or_else(|| match run.status.and_then(|s| s.code()) {
        Some(0) | None => broken(format!("respondió \"{}\"", out.trim())),
        Some(code) => broken(format!("terminó con código {code}")),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeError {
    /// `CLAUDE_BIN` apunta a algo que no existe o no se puede ejecutar.
    Missing {
        path: PathBuf,
    },
    NotFound {
        shell: PathBuf,
        name: String,
    },
}

impl fmt::Display for ClaudeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing { path } => write!(
                f,
                "CLAUDE_BIN apunta a {}, que no existe o no se puede ejecutar.",
                path.display()
            ),
            Self::NotFound { shell, name } => write!(
                f,
                "No encontré el binario de Claude Code (\"{name}\") en el PATH de tu shell de login ({}) \
                 ni en las rutas de siempre. Instalalo o definí CLAUDE_BIN.",
                shell.display()
            ),
        }
    }
}

/// `claude`: `CLAUDE_BIN` (una ruta o un nombre) o el del PATH combinado.
pub fn find_claude(
    claude_bin: Option<&str>,
    path: &OsStr,
    shell: &Path,
) -> Result<PathBuf, ClaudeError> {
    let name = claude_bin.filter(|s| !s.is_empty()).unwrap_or("claude");
    if name.contains('/') {
        let p = PathBuf::from(name);
        return if is_executable(&p) {
            Ok(p)
        } else {
            Err(ClaudeError::Missing { path: p })
        };
    }
    which(name, path).ok_or_else(|| ClaudeError::NotFound {
        shell: shell.to_path_buf(),
        name: name.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn exe(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("v24.0.0"), Some((24, 0, 0)));
        assert_eq!(parse_version("v23.9"), Some((23, 9, 0)));
        assert_eq!(
            parse_version("v24.21.0-nightly20260901abc\n"),
            Some((24, 21, 0))
        );
        assert_eq!(parse_version("24"), Some((24, 0, 0)));
        assert_eq!(parse_version("v24.1.2+build"), Some((24, 1, 2)));
        for bad in ["", "node", "vX.1", "v24.x", "basura"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
        assert!(parse_version("v24.0.0").unwrap() > parse_version("v23.99.99").unwrap());
    }

    #[test]
    fn node_from_path_with_version_check() {
        let dir = tempfile::tempdir().unwrap();
        let old = tempfile::tempdir().unwrap();
        exe(dir.path(), "node", "echo v24.21.0");
        exe(old.path(), "node", "echo v22.1.0");
        let shell = Path::new("/bin/zsh");

        let path = std::env::join_paths([dir.path(), old.path()]).unwrap();
        let n = find_node(None, None, &path, shell).unwrap();
        assert_eq!(n.version, (24, 21, 0));
        assert_eq!(n.source, NodeSource::Path);

        let path = std::env::join_paths([old.path(), dir.path()]).unwrap();
        let err = find_node(None, None, &path, shell).unwrap_err();
        assert!(matches!(
            err,
            NodeError::TooOld {
                version: (22, 1, 0),
                ..
            }
        ));
        assert!(err.to_string().contains("encontré v22.1.0 en"), "{err}");
    }

    #[test]
    fn chosen_node_wins_and_must_exist() {
        let dir = tempfile::tempdir().unwrap();
        let chosen = exe(dir.path(), "mi-node", "echo v25.0.0");
        let empty = OsString::new();
        let shell = Path::new("/bin/zsh");

        let n = find_node(Some(&chosen), Some("/otro/node"), &empty, shell).unwrap();
        assert_eq!((n.source, n.version), (NodeSource::Settings, (25, 0, 0)));

        let n = find_node(None, chosen.to_str(), &empty, shell).unwrap();
        assert_eq!(n.source, NodeSource::EnvVar);

        let path = OsString::from(dir.path());
        let n = find_node(None, Some("mi-node"), &path, shell).unwrap();
        assert_eq!((n.path, n.source), (chosen.clone(), NodeSource::EnvVar));
        assert!(matches!(
            find_node(None, Some("otro-node"), &path, shell),
            Err(NodeError::Missing { .. })
        ));

        let err = find_node(Some(Path::new("/no/existe/node")), None, &empty, shell).unwrap_err();
        assert!(matches!(
            err,
            NodeError::Missing {
                source: NodeSource::Settings,
                ..
            }
        ));
    }

    #[test]
    fn node_not_found_says_where_it_looked() {
        let dir = tempfile::tempdir().unwrap();
        let path = std::env::join_paths([dir.path(), Path::new("/nada")]).unwrap();
        let err = find_node(None, None, &path, Path::new("/usr/bin/fish")).unwrap_err();
        assert_eq!(
            err,
            NodeError::NotFound {
                shell: "/usr/bin/fish".into(),
                dirs: 2
            }
        );
        let msg = err.to_string();
        assert!(
            msg.contains("2 carpetas") && msg.contains("/usr/bin/fish"),
            "{msg}"
        );
    }

    #[test]
    fn broken_node() {
        let dir = tempfile::tempdir().unwrap();
        let shell = Path::new("/bin/zsh");
        let empty = OsString::new();
        let n = exe(dir.path(), "roto", "exit 4");
        assert!(matches!(
            find_node(Some(&n), None, &empty, shell),
            Err(NodeError::Broken { detail, .. }) if detail.contains("código 4")
        ));
        let n = exe(dir.path(), "raro", "echo hola");
        assert!(matches!(
            find_node(Some(&n), None, &empty, shell),
            Err(NodeError::Broken { .. })
        ));
        // Un archivo sin permiso de ejecución no cuenta como node.
        let f = dir.path().join("no-ejecutable");
        std::fs::write(&f, "x").unwrap();
        assert!(matches!(
            find_node(Some(&f), None, &empty, shell),
            Err(NodeError::Missing { .. })
        ));
    }

    #[test]
    fn claude_from_env_or_path() {
        let dir = tempfile::tempdir().unwrap();
        let shell = Path::new("/bin/zsh");
        let bin = exe(dir.path(), "claude", "true");
        let path = OsString::from(dir.path());
        assert_eq!(find_claude(None, &path, shell), Ok(bin.clone()));
        assert_eq!(find_claude(Some(""), &path, shell), Ok(bin.clone()));
        assert_eq!(find_claude(bin.to_str(), &OsString::new(), shell), Ok(bin));
        assert!(matches!(
            find_claude(Some("/no/claude"), &path, shell),
            Err(ClaudeError::Missing { .. })
        ));
        let err = find_claude(Some("claude-beta"), &path, shell).unwrap_err();
        assert!(err.to_string().contains("\"claude-beta\""), "{err}");
    }

    #[test]
    fn which_skips_relative_and_non_executables() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("node"), "x").unwrap();
        let path = std::env::join_paths([Path::new("."), dir.path()]).unwrap();
        assert_eq!(which("node", &path), None);
    }
}
