//! Todo lo que hace falta para lanzar el server, calculado una vez al arrancar la app:
//! el entorno de la shell de login, el PATH combinado, el entorno final y `node`/`claude`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::login_env::{self, LoginEnv};
use crate::node::{self, ClaudeError, NodeError, NodeInfo};
use crate::settings::Settings;

#[derive(Debug, Clone)]
pub struct LaunchEnv {
    pub login: LoginEnv,
    /// PATH combinado (login → app → respaldo).
    pub path: OsString,
    /// Entorno con el que se lanza el server (T3 le suma sus `CONTROL_PLANE_*`).
    pub server_env: BTreeMap<String, String>,
    pub node: Result<NodeInfo, NodeError>,
    pub claude: Result<PathBuf, ClaudeError>,
}

impl LaunchEnv {
    pub fn prepare(settings: &Settings) -> Self {
        // Sin lo que pone un AppImage: ni la shell ni el server tienen que ver sus librerías.
        let app_env: Vec<(String, String)> = login_env::without_bundle_env(std::env::vars())
            .into_iter()
            .collect();
        let get = |k: &str| {
            app_env
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
        };
        let home = get("HOME").map(PathBuf::from);
        let shell = login_env::detect_shell(get("SHELL"));
        let login = LoginEnv::read_with(
            &shell,
            &settings.import_env,
            login_env::TIMEOUT,
            Some(&app_env.iter().cloned().collect()),
        );
        let path = login_env::merge_path(
            login.get("PATH"),
            get("PATH"),
            &login_env::fallback_dirs(home.as_deref()),
            Path::is_dir,
        );
        let server_env = login_env::server_env(app_env.clone(), &login, &path);
        let env = |k: &str| server_env.get(k).map(String::as_str);
        let node = node::find_node_with(
            settings.node_path.as_deref(),
            env("CONTROL_PLANE_NODE"),
            &path,
            &shell,
            Some(&server_env),
        );
        let claude = node::find_claude(env("CLAUDE_BIN"), &path, &shell);
        Self {
            login,
            path,
            server_env,
            node,
            claude,
        }
    }

    /// Una variable de la shell de login (solo las de la lista blanca), p. ej. `CONTROL_PLANE_PORT`.
    pub fn login_var(&self, name: &str) -> Option<&str> {
        self.login.get(name)
    }

    /// Una línea para el log: nunca valores de variables, y las rutas con `~`.
    pub fn summary(&self) -> String {
        let home = self.server_env.get("HOME").map(PathBuf::from);
        let tilde = |p: &Path| tilde(p, home.as_deref());
        let shell = match &self.login.error {
            None => format!(
                "shell {} en {} ms ({} variables)",
                tilde(&self.login.shell),
                self.login.elapsed.as_millis(),
                self.login.vars.len()
            ),
            Some(e) => format!(
                "shell {}: {e}, uso las rutas de respaldo",
                tilde(&self.login.shell)
            ),
        };
        let entries = std::env::split_paths(&self.path).count();
        let node = match &self.node {
            Ok(n) => format!(
                "node v{}.{}.{} en {}",
                n.version.0,
                n.version.1,
                n.version.2,
                tilde(&n.path)
            ),
            Err(NodeError::TooOld { version, .. }) => {
                format!("node viejo (v{}.{}.{})", version.0, version.1, version.2)
            }
            Err(_) => "node: no".into(),
        };
        let claude = match &self.claude {
            Ok(p) => format!("claude en {}", tilde(p)),
            Err(_) => "claude: no".into(),
        };
        format!("Entorno: {shell} · PATH con {entries} entradas · {node} · {claude}")
    }
}

fn tilde(p: &Path, home: Option<&Path>) -> String {
    match home.and_then(|h| p.strip_prefix(h).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.display()),
        None => p.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_only_replaces_the_home_prefix() {
        let home = Path::new("/home/u");
        assert_eq!(
            tilde(Path::new("/home/u/.nvm/bin/node"), Some(home)),
            "~/.nvm/bin/node"
        );
        assert_eq!(tilde(Path::new("/home/u"), Some(home)), "~");
        assert_eq!(
            tilde(Path::new("/home/usuario2/x"), Some(home)),
            "/home/usuario2/x"
        );
        assert_eq!(tilde(Path::new("/usr/bin/node"), None), "/usr/bin/node");
    }

    #[test]
    fn summary_has_no_variable_values() {
        let mut env = LaunchEnv::prepare(&Settings::default());
        env.login.vars.insert(
            "CONTROL_PLANE_HOME".into(),
            "valor-secreto-de-prueba".into(),
        );
        let line = env.summary();
        assert!(line.starts_with("Entorno: shell "), "{line}");
        assert!(!line.contains("valor-secreto-de-prueba"), "{line}");
    }
}
