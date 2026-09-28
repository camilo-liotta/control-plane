//! Avisar cuando hay una versión nueva y actualizar con un clic.
//!
//! La app consulta el último release **publicado** de este repo en GitHub (nada de borradores ni
//! prereleases) al arrancar y después una vez por día, y lo compara con su versión. Es lo único que
//! la app pide afuera de esta máquina: no manda ningún dato tuyo (solo un User-Agent con la
//! versión) y se apaga en la bandeja → "Buscar actualizaciones".
//!
//! - Solo en builds de release. En desarrollo, únicamente con `CONTROL_PLANE_UPDATE_URL` (sirve
//!   también para probar contra un server falso local).
//! - La consulta la hace el `curl` del sistema: la app no trae un stack TLS propio y usa los
//!   certificados del sistema (el mismo curl que usa `get.sh`).
//! - Actualizar lanza el `get.sh` que vino empaquetado con la app (no uno bajado en el momento),
//!   desacoplado de ella: baja el paquete, lo verifica contra SHA256SUMS, cierra la app con
//!   `--quit --keep-server`, instala y la vuelve a abrir. Las sesiones siguen.
//! - Nada de esto se puede disparar desde el dashboard: la web solo recibe un cartel informativo.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::desktop_ws::{Local, Toast};
use crate::AppState;

/// De dónde salen las versiones. Un fork lo cambia acá.
pub const OWNER: &str = "camilo-liotta";
pub const REPO: &str = "control-plane";

const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Al arrancar, un rato después (que primero levante el server).
const FIRST_CHECK: Duration = Duration::from_secs(20);
const MAX_RESPONSE: usize = 1 << 20;

// ---- Modelo (se prueba solo) ----

/// Una versión `X.Y.Z` (sin sufijos: un prerelease nunca se ofrece).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u64, pub u64, pub u64);

impl Version {
    /// `X.Y.Z` o `vX.Y.Z`, con números sin ceros de más. Cualquier otra cosa, `None`.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.strip_prefix('v').unwrap_or(s);
        let mut parts = s.split('.');
        let mut next = || -> Option<u64> {
            let p = parts.next()?;
            let ok = !p.is_empty()
                && p.len() <= 9
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p == "0" || !p.starts_with('0'));
            ok.then(|| p.parse().ok()).flatten()
        };
        let v = Version(next()?, next()?, next()?);
        parts.next().is_none().then_some(v)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Las notas del release, armadas acá (no con lo que diga la API).
pub fn notes_url(v: Version) -> String {
    format!("https://github.com/{OWNER}/{REPO}/releases/tag/v{v}")
}

#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// La versión del último release publicado, de la respuesta de `/releases/latest`.
pub fn parse_latest(json: &str) -> Option<Version> {
    let r: ApiRelease = serde_json::from_str(json).ok()?;
    if r.draft || r.prerelease {
        return None;
    }
    Version::parse(&r.tag_name)
}

/// ¿Hay algo más nuevo que lo instalado?
pub fn newer(current: Version, latest: Option<Version>) -> Option<Version> {
    latest.filter(|l| *l > current)
}

/// ¿Avisar de esta versión? Una sola vez cada una (se anota en los ajustes).
pub fn should_announce(already: Option<&str>, v: Version) -> bool {
    already.and_then(Version::parse) != Some(v)
}

/// A qué URL preguntar, o `None` si no se busca. En release, la API de GitHub; en desarrollo,
/// solo si se define `CONTROL_PLANE_UPDATE_URL` (https, o http a esta máquina para probar).
pub fn check_url(debug: bool, env_url: Option<&str>) -> Option<String> {
    if let Some(u) = env_url.map(str::trim).filter(|u| !u.is_empty()) {
        let local = ["http://127.0.0.1:", "http://localhost:"]
            .iter()
            .any(|p| u.starts_with(p));
        return (u.starts_with("https://") || local).then(|| u.to_string());
    }
    (!debug).then(|| format!("https://api.github.com/repos/{OWNER}/{REPO}/releases/latest"))
}

/// La consulta de este ciclo, o `None` si no toca: con "Buscar actualizaciones" apagado no se
/// consulta nada, ni siquiera a un server de prueba.
pub fn request_url(enabled: bool, debug: bool, env_url: Option<&str>) -> Option<String> {
    enabled.then(|| check_url(debug, env_url)).flatten()
}

/// Los argumentos de `curl` para la consulta: sin cookies, sin nada tuyo, con límite de tiempo.
pub fn curl_args(url: &str, app_version: &str) -> Vec<String> {
    let proto = if url.starts_with("https://") {
        "=https"
    } else {
        "=http"
    };
    [
        "-fsS",
        "--max-time",
        "20",
        "--max-filesize",
        "1048576",
        "--proto",
        proto,
        "-H",
        "Accept: application/vnd.github+json",
        "-A",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([
        format!("control-plane-desktop/{app_version}"),
        url.to_string(),
    ])
    .collect()
}

/// Cómo está instalada la app, para que `get.sh` reemplace lo que corresponde.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// `.deb` (Linux, con apt).
    Deb,
    /// Un AppImage: se reemplaza ese archivo.
    AppImage(PathBuf),
    /// La `.app` de macOS que está corriendo.
    MacApp(PathBuf),
}

/// El comando del instalador: `bash <get.sh> --version X.Y.Z --app-pid <pid> …`. Cada argumento
/// va aparte (nunca por una shell) y la versión es una [`Version`] ya validada.
pub fn installer_args(script: &Path, v: Version, pid: u32, install: &Install) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        script.into(),
        "--version".into(),
        v.to_string().into(),
        "--app-pid".into(),
        pid.to_string().into(),
    ];
    match install {
        Install::Deb => {}
        Install::AppImage(p) => args.extend(["--appimage".into(), p.into()]),
        Install::MacApp(p) => args.extend(["--mac-app".into(), p.into()]),
    }
    args
}

/// La `.app` que contiene al ejecutable (`…/X.app/Contents/MacOS/bin`).
pub fn mac_app_of(exe: &Path) -> Option<PathBuf> {
    let app = exe.parent()?.parent()?.parent()?;
    (app.extension()? == "app").then(|| app.to_path_buf())
}

/// La última línea con texto del log: el motivo que deja `get.sh` al fallar.
pub fn last_line(log: &str) -> Option<String> {
    log.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| {
            l.trim_start_matches(['✗', '!', '▸', ' '])
                .chars()
                .take(200)
                .collect()
        })
}

// ---- Estado y bucle ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Available(Version),
    Updating(Version),
}

enum Cmd {
    CheckNow,
    Update,
}

/// Estado de Tauri (`app.state::<Updater>()`).
pub struct Updater {
    tx: Mutex<Sender<Cmd>>,
    status: Arc<Mutex<Status>>,
}

impl Updater {
    pub fn status(&self) -> Status {
        *self.status.lock().unwrap()
    }
    /// Buscar ya (al prender "Buscar actualizaciones").
    pub fn check_now(&self) {
        let _ = self.tx.lock().unwrap().send(Cmd::CheckNow);
    }
    /// Actualizar a la versión encontrada (desde la bandeja o el aviso; nunca desde la web).
    pub fn update(&self) {
        let _ = self.tx.lock().unwrap().send(Cmd::Update);
    }
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let (tx, rx) = mpsc::channel();
    let status = Arc::new(Mutex::new(Status::Idle));
    app.manage(Updater {
        tx: Mutex::new(tx),
        status: status.clone(),
    });
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("actualizaciones".into())
        .spawn(move || {
            let mut wait = FIRST_CHECK;
            loop {
                match rx.recv_timeout(wait) {
                    Ok(Cmd::Update) => {
                        run_update(&app, &status);
                        continue;
                    }
                    Ok(Cmd::CheckNow) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                check(&app, &status);
                wait = CHECK_EVERY;
            }
        });
}

fn current_version<R: Runtime>(app: &AppHandle<R>) -> Version {
    let v = &app.package_info().version;
    Version(v.major, v.minor, v.patch)
}

/// Una consulta. Sin red, con rate limit o con error: nada, y se reintenta en el próximo ciclo.
fn check<R: Runtime>(app: &AppHandle<R>, status: &Mutex<Status>) {
    let enabled = app.state::<AppState>().settings().check_updates;
    let env_url = std::env::var("CONTROL_PLANE_UPDATE_URL").ok();
    let Some(url) = request_url(enabled, cfg!(debug_assertions), env_url.as_deref()) else {
        return;
    };
    let current = current_version(app);
    let out = Command::new("curl")
        .args(curl_args(&url, &current.to_string()))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(out) = out else { return };
    if !out.status.success() || out.stdout.len() > MAX_RESPONSE {
        return;
    }
    let latest = parse_latest(&String::from_utf8_lossy(&out.stdout));
    let Some(v) = newer(current, latest) else {
        return;
    };
    {
        let mut st = status.lock().unwrap();
        if matches!(*st, Status::Updating(_)) {
            return;
        }
        *st = Status::Available(v);
    }
    eprintln!("Hay una versión nueva: v{v} (esta es v{current}).");
    show(app, Status::Available(v));
    // Un solo aviso nativo por versión.
    let state = app.state::<AppState>();
    if should_announce(state.settings().update_notified.as_deref(), v) {
        state.update_settings(|s| s.update_notified = Some(v.to_string()));
        crate::notify::handle(
            app,
            Toast {
                level: "info".into(),
                title: format!("Hay una versión nueva de control-plane (v{v})"),
                body: Some("Tocá para actualizar. Las sesiones siguen abiertas.".into()),
                local: Some(Local::Update),
                ..Toast::default()
            },
        );
    }
}

/// Refleja el estado en la bandeja y en el cartel de la web.
fn show<R: Runtime>(app: &AppHandle<R>, st: Status) {
    if let Some(tray) = app.try_state::<crate::tray::Tray<R>>() {
        tray.set_update(st);
    }
    if let Status::Available(v) = st {
        push_banner(app, v);
    }
}

/// El cartel de la web: solo informa (no hay forma de actualizar desde ahí).
fn push_banner<R: Runtime>(app: &AppHandle<R>, v: Version) {
    if let Some(w) = app.get_webview_window(crate::window::MAIN) {
        let info = serde_json::json!({ "version": v.to_string(), "notesUrl": notes_url(v) });
        let _ = w.eval(format!("window.__cpDesktop?.update?.({info})"));
    }
}

/// Cada vez que carga la página del dashboard, si hay una versión nueva, se le vuelve a avisar.
pub fn on_page_load<R: Runtime>(app: &AppHandle<R>) {
    if let Some(Status::Available(v)) = app.try_state::<Updater>().map(|u| u.status()) {
        push_banner(app, v);
    }
}

/// El `get.sh` que vino con la app. En desarrollo, el del repo (o `CONTROL_PLANE_UPDATE_SCRIPT`,
/// solo para probar).
fn script_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(p) = std::env::var_os("CONTROL_PLANE_UPDATE_SCRIPT") {
            return PathBuf::from(p);
        }
        return Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/get.sh");
    }
    app.path()
        .resource_dir()
        .map(|d| d.join("get.sh"))
        .unwrap_or_else(|_| PathBuf::from("get.sh"))
}

fn install_kind<R: Runtime>(_app: &AppHandle<R>) -> Install {
    // `Env::appimage` existe solo en Linux.
    #[cfg(target_os = "linux")]
    if let Some(p) = _app.env().appimage {
        return Install::AppImage(PathBuf::from(p));
    }
    #[cfg(target_os = "macos")]
    if let Some(app_dir) = std::env::current_exe().ok().as_deref().and_then(mac_app_of) {
        return Install::MacApp(app_dir);
    }
    Install::Deb
}

fn log_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let p = app.path();
    let data = p.app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    p.app_log_dir()
        .unwrap_or_else(|_| data.join("logs"))
        .join("update.log")
}

/// Lanza el instalador desacoplado (su propia sesión: sobrevive a que la app salga) y espera.
/// Si termina mal con la app todavía abierta, avisa con el motivo; la app vieja sigue igual.
fn run_update<R: Runtime>(app: &AppHandle<R>, status: &Mutex<Status>) {
    let v = {
        let mut st = status.lock().unwrap();
        let Status::Available(v) = *st else { return };
        *st = Status::Updating(v);
        v
    };
    show(app, Status::Updating(v));
    let log = log_path(app);
    let result = spawn_installer(app, v, &log).and_then(|mut child| {
        child.wait().map_err(|e| e.to_string()).and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                let text = std::fs::read_to_string(&log).unwrap_or_default();
                Err(last_line(&text).unwrap_or_else(|| format!("terminó con {s}")))
            }
        })
    });
    // Si llegamos acá, la app sigue abierta: o falló, o no hizo falta cerrarla.
    *status.lock().unwrap() = Status::Available(v);
    show(app, Status::Available(v));
    if let Err(why) = result {
        eprintln!("No pude actualizar a v{v}: {why}");
        crate::notify::handle(
            app,
            Toast {
                level: "error".into(),
                title: "No pude actualizar control-plane".into(),
                body: Some(format!("{why} Tocá para ver el log.")),
                local: Some(Local::OpenLog(log)),
                ..Toast::default()
            },
        );
    }
}

fn spawn_installer<R: Runtime>(
    app: &AppHandle<R>,
    v: Version,
    log: &Path,
) -> Result<std::process::Child, String> {
    let script = script_path(app);
    if !script.is_file() {
        return Err(format!(
            "No encuentro el instalador ({}).",
            script.display()
        ));
    }
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let out = std::fs::File::create(log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let args = installer_args(&script, v, std::process::id(), &install_kind(app));
    eprintln!(
        "Actualizo a v{v}: bash {:?} (log en {})",
        args,
        log.display()
    );
    let mut cmd = Command::new("bash");
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .env_remove("NODE_ENV");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Sesión propia: no se corta cuando la app sale (get.sh la cierra y la vuelve a abrir).
        // SAFETY: setsid es async-signal-safe y no toca memoria del padre.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    cmd.spawn()
        .map_err(|e| format!("No pude lanzar el instalador: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn versions_parse_strictly_and_compare() {
        assert_eq!(Version::parse("0.1.0"), Some(Version(0, 1, 0)));
        assert_eq!(Version::parse("v1.20.3"), Some(Version(1, 20, 3)));
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "1.2.3-beta",
            "01.2.3",
            "1..3",
            "a.b.c",
            " 1.2.3",
            "1.2.3;rm",
            "--quit",
            "1.2.3 ",
        ] {
            assert_eq!(Version::parse(bad), None, "{bad:?}");
        }
        assert!(Version(0, 10, 0) > Version(0, 9, 9));
        assert!(Version(1, 0, 0) > Version(0, 99, 99));
        assert_eq!(Version(1, 2, 3).to_string(), "1.2.3");
    }

    #[test]
    fn api_response_ignores_drafts_and_prereleases() {
        let ok = r#"{"tag_name":"v0.2.0","draft":false,"prerelease":false,"html_url":"https://x"}"#;
        assert_eq!(parse_latest(ok), Some(Version(0, 2, 0)));
        assert_eq!(parse_latest(r#"{"tag_name":"v0.2.0","draft":true}"#), None);
        assert_eq!(
            parse_latest(r#"{"tag_name":"v0.2.0","prerelease":true}"#),
            None
        );
        assert_eq!(parse_latest(r#"{"tag_name":"v0.2.0-rc.1"}"#), None);
        assert_eq!(
            parse_latest(r#"{"message":"API rate limit exceeded"}"#),
            None
        );
        assert_eq!(parse_latest("no es json"), None);
    }

    #[test]
    fn only_newer_versions_are_offered() {
        let cur = Version(0, 2, 0);
        assert_eq!(newer(cur, Some(Version(0, 3, 0))), Some(Version(0, 3, 0)));
        assert_eq!(newer(cur, Some(Version(0, 2, 0))), None);
        assert_eq!(newer(cur, Some(Version(0, 1, 9))), None);
        assert_eq!(newer(cur, None), None);
    }

    #[test]
    fn announce_once_per_version() {
        let v = Version(0, 3, 0);
        assert!(should_announce(None, v));
        assert!(should_announce(Some("0.2.0"), v));
        assert!(!should_announce(Some("0.3.0"), v));
        assert!(should_announce(Some("basura"), v));
    }

    #[test]
    fn where_to_ask() {
        let api = "https://api.github.com/repos/camilo-liotta/control-plane/releases/latest";
        assert_eq!(check_url(false, None).as_deref(), Some(api));
        // En desarrollo, nada sin la variable.
        assert_eq!(check_url(true, None), None);
        assert_eq!(check_url(true, Some("  ")), None);
        assert_eq!(
            check_url(true, Some("http://127.0.0.1:4739/latest")).as_deref(),
            Some("http://127.0.0.1:4739/latest")
        );
        // http solo a esta máquina.
        assert_eq!(check_url(false, Some("http://evil.example/latest")), None);
        assert_eq!(check_url(true, Some("file:///etc/passwd")), None);
    }

    #[test]
    fn nothing_is_asked_with_the_setting_off() {
        assert_eq!(request_url(false, false, None), None);
        assert_eq!(
            request_url(false, true, Some("http://127.0.0.1:4739/x")),
            None
        );
        assert!(request_url(true, false, None).is_some());
    }

    #[test]
    fn the_request_sends_nothing_personal() {
        let a = curl_args("https://api.github.com/x", "0.1.0");
        assert!(a.contains(&"=https".to_string()));
        assert!(a.contains(&"control-plane-desktop/0.1.0".to_string()));
        assert_eq!(a.last().unwrap(), "https://api.github.com/x");
        let joined = a.join(" ");
        for bad in ["-b", "--cookie", "-u ", "-d ", "--data", "Authorization"] {
            assert!(!joined.contains(bad), "{bad}");
        }
        assert!(curl_args("http://127.0.0.1:1/x", "0.1.0").contains(&"=http".to_string()));
    }

    #[test]
    fn installer_command() {
        let s = Path::new("/usr/lib/control-plane/get.sh");
        let v = Version(0, 3, 0);
        let args = |i: &Install| -> Vec<String> {
            installer_args(s, v, 42, i)
                .into_iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(
            args(&Install::Deb),
            [s.to_str().unwrap(), "--version", "0.3.0", "--app-pid", "42"]
        );
        assert_eq!(
            args(&Install::AppImage("/home/u/Mis Apps/cp.AppImage".into()))[5..],
            ["--appimage", "/home/u/Mis Apps/cp.AppImage"]
        );
        assert_eq!(
            args(&Install::MacApp("/Applications/control-plane.app".into()))[5..],
            ["--mac-app", "/Applications/control-plane.app"]
        );
    }

    #[test]
    fn mac_app_from_the_executable() {
        assert_eq!(
            mac_app_of(Path::new(
                "/Applications/control-plane.app/Contents/MacOS/control-plane-desktop"
            )),
            Some(PathBuf::from("/Applications/control-plane.app"))
        );
        assert_eq!(
            mac_app_of(Path::new("/usr/bin/control-plane-desktop")),
            None
        );
    }

    #[test]
    fn failure_reason_is_the_last_line() {
        assert_eq!(
            last_line("▸ Bajo el paquete…\n✗ El sha256 no coincide: no lo instalo.\n\n").as_deref(),
            Some("El sha256 no coincide: no lo instalo.")
        );
        assert_eq!(last_line("\n \n"), None);
    }

    /// Contra un server HTTP falso local (nunca contra GitHub): curl real, parseo y comparación.
    #[test]
    fn asks_a_local_fake_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = r#"{"tag_name":"v9.0.0","draft":false,"prerelease":false}"#;
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            req
        });
        let url = check_url(true, Some(&format!("http://127.0.0.1:{port}/latest"))).unwrap();
        let out = Command::new("curl")
            .args(curl_args(&url, "0.1.0"))
            .output()
            .unwrap();
        let req = server.join().unwrap();
        assert!(out.status.success());
        assert_eq!(
            newer(
                Version(0, 1, 0),
                parse_latest(&String::from_utf8_lossy(&out.stdout))
            ),
            Some(Version(9, 0, 0))
        );
        assert!(req.starts_with("GET /latest "));
        assert!(req.contains("User-Agent: control-plane-desktop/0.1.0"));
        assert!(!req.to_ascii_lowercase().contains("cookie"));
    }
}
