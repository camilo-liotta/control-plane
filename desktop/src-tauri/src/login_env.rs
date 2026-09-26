//! El entorno de la shell de login del usuario.
//!
//! Una app abierta desde el Finder o desde el menú de aplicaciones no hereda el PATH de la
//! terminal: no ve `node` de nvm, lo instalado con brew ni `claude`. Acá se le pregunta a la
//! shell de login (`$SHELL -l -i -c …`) su entorno, se separa del ruido que imprimen los
//! archivos de inicio con dos marcadores y se queda solo con una lista blanca de variables.

use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{fmt, thread};

pub const TIMEOUT: Duration = Duration::from_secs(5);

/// Variables de la shell de login que siempre se traen (además de `LC_*` y `CONTROL_PLANE_*`).
const ALLOWED: &[&str] = &[
    "PATH",
    "LANG",
    "LANGUAGE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HOMEBREW_PREFIX",
    "SSH_AUTH_SOCK",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_BIN",
];
const ALLOWED_PREFIXES: &[&str] = &["LC_", "CONTROL_PLANE_"];

/// ¿Se trae esta variable de la shell de login? `import` son los nombres exactos de los ajustes.
pub fn allowed(name: &str, import: &[String]) -> bool {
    ALLOWED.contains(&name)
        || ALLOWED_PREFIXES.iter().any(|p| name.starts_with(p))
        || import.iter().any(|i| i == name)
}

/// Variables de la sesión de Claude Code que la app hereda si la lanza una sesión o una terminal
/// con Claude: el server no las tiene que ver (se conectaría a la mensajería de esa sesión).
pub fn is_claude_session_var(name: &str) -> bool {
    matches!(name, "CLAUDECODE" | "CLAUDE_PID" | "CLAUDE_EFFORT")
        || name.starts_with("CLAUDE_CODE_")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// sh, bash, zsh, dash, ksh…
    Posix,
    Fish,
    Nu,
    /// csh y tcsh: `-l` solo vale como única opción, así que se corre sin login (lee `.cshrc`).
    Csh,
}

impl ShellKind {
    pub fn of(shell: &Path) -> Self {
        match shell.file_name().and_then(|n| n.to_str()).unwrap_or("") {
            "fish" => Self::Fish,
            "nu" | "nushell" => Self::Nu,
            "csh" | "tcsh" => Self::Csh,
            _ => Self::Posix,
        }
    }
}

/// La shell del usuario: `$SHELL`, si no la de su cuenta, si no la del sistema.
pub fn detect_shell(env_shell: Option<&str>) -> PathBuf {
    if let Some(s) = env_shell.filter(|s| s.starts_with('/')) {
        return PathBuf::from(s);
    }
    if let Some(s) = account_shell() {
        return s;
    }
    PathBuf::from(if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    })
}

/// La shell de la cuenta (passwd en Linux, Open Directory en macOS: los dos vía getpwuid).
fn account_shell() -> Option<PathBuf> {
    // SAFETY: getpwuid devuelve un puntero a memoria estática o null; se copia enseguida.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let s = std::ffi::CStr::from_ptr((*pw).pw_shell).to_str().ok()?;
        s.starts_with('/').then(|| PathBuf::from(s))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvFormat {
    /// `env -0`: variables separadas por NUL (aguanta saltos de línea en los valores).
    Nul,
    /// `env` a secas, una por línea: para un `env` sin `-0`.
    Lines,
}

const MARKER_PREFIX: &str = "__CP_ENV_";

fn script(marker: &str, format: EnvFormat) -> String {
    // Solo binarios con ruta absoluta y `;`: vale igual en sh, bash, zsh, fish, nu y csh.
    let env = match format {
        EnvFormat::Nul => "/usr/bin/env -0",
        EnvFormat::Lines => "/usr/bin/env",
    };
    // El marcador va en dos pedazos: entero nunca es un argumento, así no aparece en `$_` (el
    // último argumento del comando anterior) ni en otra variable que copie la línea de comando.
    let rest = marker.strip_prefix(MARKER_PREFIX).unwrap_or(marker);
    let print = format!("/usr/bin/printf '%s%s' {MARKER_PREFIX} {rest}");
    format!("{print}; {env}; {print}")
}

fn args(kind: ShellKind, script: String) -> Vec<String> {
    match kind {
        ShellKind::Csh => vec!["-c".into(), script],
        _ => vec!["-l".into(), "-i".into(), "-c".into(), script],
    }
}

fn new_marker() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{MARKER_PREFIX}{}_{nanos:09}__", std::process::id())
}

/// Lo que queda entre el primer par de marcadores (el ruido de antes y después se descarta).
pub fn between_markers<'a>(out: &'a [u8], marker: &str) -> Option<&'a [u8]> {
    let m = marker.as_bytes();
    let start = find(out, m)? + m.len();
    let len = find(&out[start..], m)?;
    Some(&out[start..start + len])
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn parse(block: &[u8], format: EnvFormat) -> BTreeMap<String, String> {
    let sep = match format {
        EnvFormat::Nul => b'\0',
        EnvFormat::Lines => b'\n',
    };
    block
        .split(|b| *b == sep)
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (k, v) = entry.split_once('=')?;
            let valid = !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
            valid.then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginEnvError {
    /// No se pudo lanzar la shell.
    Spawn(String),
    /// La shell no terminó a tiempo (se colgó o pidió algo).
    Timeout(Duration),
    /// Terminó sin imprimir el entorno entre los marcadores.
    NoOutput(Option<i32>),
}

impl fmt::Display for LoginEnvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "no pude abrirla ({e})"),
            Self::Timeout(t) => write!(f, "no respondió en {} s", t.as_secs()),
            Self::NoOutput(Some(code)) => {
                write!(f, "terminó con código {code} sin darme el entorno")
            }
            Self::NoOutput(None) => write!(f, "terminó sin darme el entorno"),
        }
    }
}

/// El resultado de leer la shell de login: las variables de la lista blanca, o por qué no se pudo.
#[derive(Debug, Clone)]
pub struct LoginEnv {
    pub shell: PathBuf,
    pub elapsed: Duration,
    /// Solo las variables permitidas (nunca el entorno completo, que puede tener secretos).
    pub vars: BTreeMap<String, String>,
    pub error: Option<LoginEnvError>,
}

impl LoginEnv {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    /// Lee el entorno de la shell de login con un tiempo máximo.
    pub fn read(shell: &Path, import: &[String], timeout: Duration) -> Self {
        let started = Instant::now();
        let kind = ShellKind::of(shell);
        let mut result = run_shell(shell, kind, EnvFormat::Nul, timeout);
        // Un `env` sin `-0` (algún macOS viejo) no imprime nada entre los marcadores: otra vuelta
        // una por línea, con lo que quede de tiempo.
        if matches!(&result, Ok(v) if !v.contains_key("PATH")) {
            let left = timeout.saturating_sub(started.elapsed());
            result = run_shell(shell, kind, EnvFormat::Lines, left);
        }
        let (vars, error) = match result {
            Ok(all) => (
                all.into_iter()
                    .filter(|(k, _)| allowed(k, import))
                    .collect(),
                None,
            ),
            Err(e) => (BTreeMap::new(), Some(e)),
        };
        Self {
            shell: shell.to_path_buf(),
            elapsed: started.elapsed(),
            vars,
            error,
        }
    }
}

fn run_shell(
    shell: &Path,
    kind: ShellKind,
    format: EnvFormat,
    timeout: Duration,
) -> Result<BTreeMap<String, String>, LoginEnvError> {
    let marker = new_marker();
    let mut cmd = Command::new(shell);
    cmd.args(args(kind, script(&marker, format)))
        .env("TERM", "dumb")
        // oh-my-zsh: que no pregunte si actualiza.
        .env("DISABLE_AUTO_UPDATE", "true");
    let run = run_limited(cmd, timeout, Some(marker.as_bytes()))?;
    match between_markers(&run.stdout, &marker) {
        Some(block) => Ok(parse(block, format)),
        None if run.timed_out => Err(LoginEnvError::Timeout(timeout)),
        None => Err(LoginEnvError::NoOutput(run.status.and_then(|s| s.code()))),
    }
}

pub(crate) struct Limited {
    pub stdout: Vec<u8>,
    pub status: Option<ExitStatus>,
    pub timed_out: bool,
}

/// Corre un proceso en su propia sesión (sin terminal de control), con stdin en /dev/null, y
/// espera hasta `timeout`. Si `until` aparece dos veces en la salida, no espera a que termine.
/// Al final mata a todo el grupo: nada que haya lanzado la shell queda vivo.
pub(crate) fn run_limited(
    mut cmd: Command,
    timeout: Duration,
    until: Option<&[u8]>,
) -> Result<Limited, LoginEnvError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: setsid es async-signal-safe; entre fork y exec no se toca nada más.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| LoginEnvError::Spawn(e.to_string()))?;
    let pgid = child.id() as libc::pid_t;

    let out = Arc::new(Mutex::new(Vec::new()));
    let mut pipe = child.stdout.take().expect("stdout piped");
    let sink = Arc::clone(&out);
    let reader = thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            sink.lock().expect("buffer").extend_from_slice(&buf[..n]);
        }
    });

    let deadline = Instant::now() + timeout;
    let complete = |out: &Arc<Mutex<Vec<u8>>>| {
        until.is_some_and(|m| {
            let out = out.lock().expect("buffer");
            find(&out, m).is_some_and(|i| find(&out[i + m.len()..], m).is_some())
        })
    };
    let mut status = None;
    let mut timed_out = false;
    loop {
        if let Ok(Some(s)) = child.try_wait() {
            status = Some(s);
            break;
        }
        if complete(&out) {
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    // SAFETY: kill a un grupo que creamos nosotros (setsid); si ya no existe, falla sin efecto.
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    if status.is_none() {
        status = child.wait().ok();
    }
    // Un proceso que se fue a otra sesión y dejó el pipe abierto no puede trabar la lectura.
    let reader_deadline = Instant::now() + Duration::from_millis(300);
    while !reader.is_finished() && Instant::now() < reader_deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let stdout = out.lock().expect("buffer").clone();
    Ok(Limited {
        stdout,
        status,
        timed_out,
    })
}

/// Rutas de respaldo, en orden, para cuando la shell no dio un PATH o le falta algo.
pub fn fallback_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/sbin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    if let Some(home) = home {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".bun/bin"));
        if let Some(nvm) = newest_nvm_node(&home.join(".nvm/versions/node")) {
            dirs.push(nvm);
        }
    }
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/bin"));
    dirs
}

/// El `bin` del Node ≥ 24 más nuevo instalado con nvm.
fn newest_nvm_node(versions: &Path) -> Option<PathBuf> {
    std::fs::read_dir(versions)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let v = crate::node::parse_version(e.file_name().to_str()?)?;
            (v.0 >= crate::node::MIN_MAJOR).then(|| (v, e.path().join("bin")))
        })
        .max_by_key(|(v, _)| *v)
        .map(|(_, bin)| bin)
}

/// El PATH que ve el server: primero el de la shell de login, después lo que ya traía la app y
/// al final las rutas de respaldo que existan. Sin repetidos (queda la primera aparición).
pub fn merge_path(
    login: Option<&str>,
    app: Option<&str>,
    fallbacks: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> OsString {
    let mut seen = HashSet::new();
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        // Solo absolutas: una entrada vacía o relativa es el directorio actual.
        if p.is_absolute() && seen.insert(p.clone()) {
            out.push(p);
        }
    };
    for list in [login, app].into_iter().flatten() {
        std::env::split_paths(list).for_each(&mut push);
    }
    for dir in fallbacks {
        if exists(dir) {
            push(dir.clone());
        }
    }
    std::env::join_paths(out).unwrap_or_default()
}

/// El entorno con el que se lanza el server: el de la app sin lo de la sesión de Claude Code,
/// más las variables permitidas de la shell de login, con el PATH combinado. T3 le suma las
/// `CONTROL_PLANE_*` propias (puerto, launchId, web dist, hook de compactación).
pub fn server_env(
    app_env: impl IntoIterator<Item = (String, String)>,
    login: &LoginEnv,
    path: &OsString,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = app_env
        .into_iter()
        .filter(|(k, _)| !is_claude_session_var(k))
        .collect();
    for (k, v) in &login.vars {
        // El agente SSH de la app es el de la sesión gráfica: el de la shell solo si falta.
        if k == "SSH_AUTH_SOCK" && env.contains_key(k) {
            continue;
        }
        env.insert(k.clone(), v.clone());
    }
    env.insert("PATH".into(), path.to_string_lossy().into_owned());
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn login(vars: &[(&str, &str)]) -> LoginEnv {
        LoginEnv {
            shell: "/bin/sh".into(),
            elapsed: Duration::ZERO,
            vars: vars
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            error: None,
        }
    }

    /// Una shell falsa: un script de sh que recibe los mismos argumentos que la de verdad.
    fn fake_shell(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn noise_around_the_markers_is_ignored() {
        let out =
            b"Bienvenido!\n\x1b[32mnvm listo\x1b[0m\nM1PATH=/a:/b\0LANG=es_AR.UTF-8\0M1adios\n";
        let block = between_markers(out, "M1").unwrap();
        let vars = parse(block, EnvFormat::Nul);
        assert_eq!(vars["PATH"], "/a:/b");
        assert_eq!(vars["LANG"], "es_AR.UTF-8");
        assert_eq!(vars.len(), 2);
    }

    #[test]
    fn missing_or_single_marker_gives_nothing() {
        assert!(between_markers(b"PATH=/a\0", "M1").is_none());
        assert!(between_markers(b"M1PATH=/a\0", "M1").is_none());
        assert!(between_markers(b"", "M1").is_none());
    }

    #[test]
    fn only_the_first_pair_counts() {
        let out = b"M1A=1\0M1B=2\0M1";
        assert_eq!(
            parse(between_markers(out, "M1").unwrap(), EnvFormat::Nul).len(),
            1
        );
    }

    #[test]
    fn values_with_equals_and_newlines() {
        let vars = parse(
            b"A=x=y=z\0B=linea1\nlinea2\0=raro\0C D=no\0SOLO\0",
            EnvFormat::Nul,
        );
        assert_eq!(vars["A"], "x=y=z");
        assert_eq!(vars["B"], "linea1\nlinea2");
        assert_eq!(vars.len(), 2);
    }

    #[test]
    fn line_format() {
        let vars = parse(b"PATH=/a\nLANG=C\n", EnvFormat::Lines);
        assert_eq!(vars["PATH"], "/a");
        assert_eq!(vars["LANG"], "C");
    }

    #[test]
    fn whitelist_and_import_env() {
        let none: Vec<String> = vec![];
        for ok in [
            "PATH",
            "LANG",
            "LC_ALL",
            "HTTPS_PROXY",
            "no_proxy",
            "NODE_EXTRA_CA_CERTS",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_BIN",
            "CONTROL_PLANE_PORT",
            "CONTROL_PLANE_HOME",
        ] {
            assert!(allowed(ok, &none), "{ok}");
        }
        // Las de auth y cualquier otra quedan afuera por defecto…
        for no in [
            "ANTHROPIC_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_PROFILE",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GITHUB_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "NVM_DIR",
            "HOME",
        ] {
            assert!(!allowed(no, &none), "{no}");
        }
        // …salvo que estén en importEnv, con el nombre exacto.
        let import = vec![
            "AWS_PROFILE".to_string(),
            "CLAUDE_CODE_USE_BEDROCK".to_string(),
        ];
        assert!(allowed("AWS_PROFILE", &import));
        assert!(allowed("CLAUDE_CODE_USE_BEDROCK", &import));
        assert!(!allowed("AWS_PROFILE_X", &import));
        assert!(!allowed("AWS_SECRET_ACCESS_KEY", &import));
    }

    #[test]
    fn merge_order_and_dedupe() {
        let fallbacks = vec![
            PathBuf::from("/opt/x/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/nope"),
        ];
        let path = merge_path(
            Some("/login/bin:/usr/bin::relativa"),
            Some("/usr/bin:/app/bin:/login/bin"),
            &fallbacks,
            |p| p != Path::new("/nope"),
        );
        assert_eq!(
            path,
            OsString::from("/login/bin:/usr/bin:/app/bin:/opt/x/bin")
        );
        assert_eq!(
            merge_path(None, None, &fallbacks[..1], |_| true),
            OsString::from("/opt/x/bin")
        );
    }

    #[test]
    fn server_env_cleans_claude_session_and_keeps_the_rest() {
        let app = [
            ("HOME", "/home/u"),
            ("PATH", "/usr/bin"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/s"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "t"),
            ("CLAUDE_PID", "12"),
            ("CLAUDE_EFFORT", "high"),
            ("CLAUDE_CONFIG_DIR", "/app/claude"),
            ("SSH_AUTH_SOCK", "/run/app.sock"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let login = login(&[
            ("PATH", "/login/bin"),
            ("CLAUDE_CONFIG_DIR", "/login/claude"),
            ("SSH_AUTH_SOCK", "/tmp/login.sock"),
            ("CONTROL_PLANE_HOME", "/data"),
        ]);
        let env = server_env(app, &login, &OsString::from("/login/bin:/usr/bin"));
        for gone in [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_PID",
            "CLAUDE_EFFORT",
        ] {
            assert!(!env.contains_key(gone), "{gone}");
        }
        assert_eq!(env["HOME"], "/home/u");
        assert_eq!(env["PATH"], "/login/bin:/usr/bin");
        assert_eq!(env["CLAUDE_CONFIG_DIR"], "/login/claude");
        assert_eq!(env["SSH_AUTH_SOCK"], "/run/app.sock");
        assert_eq!(env["CONTROL_PLANE_HOME"], "/data");
    }

    #[test]
    fn ssh_agent_from_login_only_if_missing() {
        let login = login(&[("SSH_AUTH_SOCK", "/tmp/login.sock")]);
        let env = server_env(Vec::new(), &login, &OsString::from("/bin"));
        assert_eq!(env["SSH_AUTH_SOCK"], "/tmp/login.sock");
    }

    #[test]
    fn shell_kinds_and_args() {
        assert_eq!(ShellKind::of(Path::new("/bin/zsh")), ShellKind::Posix);
        assert_eq!(ShellKind::of(Path::new("/usr/bin/fish")), ShellKind::Fish);
        assert_eq!(
            ShellKind::of(Path::new("/opt/homebrew/bin/nu")),
            ShellKind::Nu
        );
        assert_eq!(ShellKind::of(Path::new("/bin/tcsh")), ShellKind::Csh);
        assert_eq!(args(ShellKind::Csh, "x".into()), ["-c", "x"]);
        assert_eq!(args(ShellKind::Fish, "x".into()), ["-l", "-i", "-c", "x"]);
    }

    #[test]
    fn detect_shell_prefers_absolute_env() {
        assert_eq!(
            detect_shell(Some("/usr/bin/fish")),
            PathBuf::from("/usr/bin/fish")
        );
        // Un $SHELL relativo o vacío no sirve: queda el de la cuenta o el del sistema.
        assert!(detect_shell(Some("zsh")).is_absolute());
        assert!(detect_shell(None).is_absolute());
    }

    #[test]
    fn marker_is_never_a_whole_argument() {
        let m = new_marker();
        let s = script(&m, EnvFormat::Nul);
        assert!(!s.contains(&m), "{s}");
        // dash exporta `$_` con el último argumento del printf: no puede cortar el bloque antes.
        let dir = tempfile::tempdir().unwrap();
        let sh = fake_shell(dir.path(), "bash", r#"exec /bin/sh -c "$4""#);
        let env = LoginEnv::read(&sh, &[], TIMEOUT);
        assert_eq!(env.error, None);
        assert!(env.get("PATH").is_some());
    }

    #[test]
    fn real_sh_login_env() {
        let env = LoginEnv::read(Path::new("/bin/sh"), &[], TIMEOUT);
        assert_eq!(env.error, None);
        assert!(env.get("PATH").is_some_and(|p| !p.is_empty()));
        assert!(env.vars.keys().all(|k| allowed(k, &[])));
    }

    #[test]
    fn banner_before_and_after_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let sh = fake_shell(
            dir.path(),
            "bash",
            r#"echo "Bienvenido a la máquina"; printf 'ruido sin salto'; eval "$4"; echo "chau""#,
        );
        let env = LoginEnv::read(&sh, &[], TIMEOUT);
        assert_eq!(env.error, None);
        assert!(env.get("PATH").is_some());
    }

    #[test]
    fn nonzero_exit_after_printing_still_works() {
        let dir = tempfile::tempdir().unwrap();
        let sh = fake_shell(dir.path(), "zsh", r#"eval "$4"; exit 3"#);
        assert_eq!(LoginEnv::read(&sh, &[], TIMEOUT).error, None);
    }

    #[test]
    fn shell_that_prints_nothing_reports_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let sh = fake_shell(dir.path(), "zsh", "echo roto >&2; exit 7");
        let env = LoginEnv::read(&sh, &[], TIMEOUT);
        assert_eq!(env.error, Some(LoginEnvError::NoOutput(Some(7))));
        assert!(env.vars.is_empty());
    }

    #[test]
    fn hanging_shell_times_out_and_its_children_die() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("hijo.pid");
        let sh = fake_shell(
            dir.path(),
            "zsh",
            &format!(
                "sleep 30 & echo $! > {}; read nada; sleep 30",
                pidfile.display()
            ),
        );
        let started = Instant::now();
        let env = LoginEnv::read(&sh, &[], Duration::from_millis(400));
        assert_eq!(
            env.error,
            Some(LoginEnvError::Timeout(Duration::from_millis(400)))
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        // SAFETY: señal 0 solo pregunta si el proceso existe.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "el sleep de la shell sigue vivo"
        );
    }

    #[test]
    fn background_child_holding_stdout_does_not_block() {
        let dir = tempfile::tempdir().unwrap();
        // Un proceso que se va a otra sesión y se queda con el stdout abierto.
        let sh = fake_shell(dir.path(), "bash", r#"setsid sleep 3 & eval "$4""#);
        let started = Instant::now();
        let env = LoginEnv::read(&sh, &[], TIMEOUT);
        assert_eq!(env.error, None);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn fish_style_shell_gets_the_same_arguments() {
        let dir = tempfile::tempdir().unwrap();
        // fish no es POSIX, pero el script solo usa binarios absolutos y `;`.
        let sh = fake_shell(
            dir.path(),
            "fish",
            r#"[ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ] || exit 9; eval "$4""#,
        );
        assert_eq!(LoginEnv::read(&sh, &[], TIMEOUT).error, None);
    }

    #[test]
    fn csh_style_shell_gets_only_dash_c() {
        let dir = tempfile::tempdir().unwrap();
        let sh = fake_shell(
            dir.path(),
            "tcsh",
            r#"[ "$1" = "-c" ] || exit 9; eval "$2""#,
        );
        assert_eq!(LoginEnv::read(&sh, &[], TIMEOUT).error, None);
    }

    #[test]
    fn env_without_dash_zero_falls_back_to_lines() {
        let dir = tempfile::tempdir().unwrap();
        // Un `env` que no entiende -0: imprime el uso y nada más.
        let sh = fake_shell(
            dir.path(),
            "zsh",
            r#"s=$(printf '%s' "$4" | sed 's#/usr/bin/env -0#false#'); eval "$s""#,
        );
        let env = LoginEnv::read(&sh, &[], TIMEOUT);
        assert_eq!(env.error, None);
        assert!(env.get("PATH").is_some());
    }

    #[test]
    fn filtered_vars_never_include_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let sh = fake_shell(
            dir.path(),
            "zsh",
            r#"export ANTHROPIC_API_KEY=sk-secreto AWS_PROFILE=trabajo CONTROL_PLANE_PORT=4711; eval "$4""#,
        );
        let env = LoginEnv::read(&sh, &[], TIMEOUT);
        assert!(!env.vars.contains_key("ANTHROPIC_API_KEY"));
        assert!(!env.vars.contains_key("AWS_PROFILE"));
        assert_eq!(env.get("CONTROL_PLANE_PORT"), Some("4711"));
        let env = LoginEnv::read(&sh, &["AWS_PROFILE".into()], TIMEOUT);
        assert_eq!(env.get("AWS_PROFILE"), Some("trabajo"));
        assert!(!env.vars.contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn nvm_fallback_picks_newest_24_plus() {
        let dir = tempfile::tempdir().unwrap();
        let versions = dir.path().join(".nvm/versions/node");
        for v in [
            "v22.9.0",
            "v24.2.0",
            "v24.21.0",
            "v25.0.0-nightly2026",
            "basura",
        ] {
            std::fs::create_dir_all(versions.join(v).join("bin")).unwrap();
        }
        assert_eq!(
            newest_nvm_node(&versions),
            Some(versions.join("v25.0.0-nightly2026/bin"))
        );
        let dirs = fallback_dirs(Some(dir.path()));
        assert!(dirs.contains(&versions.join("v25.0.0-nightly2026/bin")));
        assert_eq!(dirs.last(), Some(&PathBuf::from("/bin")));
    }
}
