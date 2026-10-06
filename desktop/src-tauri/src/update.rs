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
//!   desacoplado de ella: baja el paquete, lo verifica contra SHA256SUMS, instala, cierra la app
//!   con `--quit --restart-for-update` (el server guarda las sesiones activas y se detiene) y la
//!   vuelve a abrir: la app nueva lanza el server nuevo, que retoma las sesiones. App y server se
//!   actualizan siempre juntos.
//! - Si hay sesiones trabajando, antes se pregunta: esperar a que terminen, actualizar ya o no.
//! - "Buscar ahora" (en el menú del ícono) consulta en el momento, aunque "Buscar actualizaciones"
//!   esté apagado, y siempre dice qué encontró (también si ya estás en la última).
//! - El dashboard no puede disparar nada de esto: la web solo recibe un cartel informativo. La
//!   única excepción es "Reintentar" en "No se pudo actualizar". Ese botón navega a una URL de acción
//!   con un token de un solo uso, que la app genera con cada falla y le pasa solo a su ventana.
//!   Sirve para volver a intentar la misma versión, y nada más.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::desktop_ws::{Local, Toast};
use crate::launch_env::LaunchEnv;
use crate::policy::{self, UpdateStart};
use crate::AppState;

/// De dónde salen las versiones. Un fork lo cambia acá.
pub const OWNER: &str = "camilo-liotta";
pub const REPO: &str = "control-plane";

const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// Al arrancar, un rato después (que primero levante el server).
const FIRST_CHECK: Duration = Duration::from_secs(20);
const MAX_RESPONSE: usize = 1 << 20;
/// Por su ruta, no por el PATH (en Linux y en la Mac están ahí).
const CURL: &str = "/usr/bin/curl";
const BASH: &str = "/bin/bash";

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

/// A qué URL preguntar, o `None` si no se busca. En release, siempre la API de GitHub (la
/// variable no cuenta); en desarrollo, solo si se define `CONTROL_PLANE_UPDATE_URL` (https, o
/// http a esta máquina para probar).
pub fn check_url(debug: bool, env_url: Option<&str>) -> Option<String> {
    if !debug {
        return Some(format!(
            "https://api.github.com/repos/{OWNER}/{REPO}/releases/latest"
        ));
    }
    let u = env_url.map(str::trim).filter(|u| !u.is_empty())?;
    let local = ["http://127.0.0.1:", "http://localhost:"]
        .iter()
        .any(|p| u.starts_with(p));
    (u.starts_with("https://") || local).then(|| u.to_string())
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

/// El locale con el que corre el instalador: en la Mac, `LC_ALL=C`. Con un locale UTF-8, la libc
/// de la Mac toma los bytes 0x80–0xFF como letras (Latin-1) y el bash 3.2 suma los de "…" al
/// nombre de una `$var` pegada (`"Bajo $file…"` cortó `get.sh` en la 0.2.0). Con C no pasa. En
/// Linux no hace falta, y no conviene: `get.sh` reabre la app con su mismo entorno.
pub fn installer_locale() -> Option<(&'static str, &'static str)> {
    cfg!(target_os = "macos").then_some(("LC_ALL", "C"))
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

/// Lo que encontró una consulta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    Newer(Version),
    /// Ya está en la última publicada (o en una más nueva).
    UpToDate(Version),
    Failed(String),
    /// No se consulta (la app de desarrollo sin `CONTROL_PLANE_UPDATE_URL`).
    Off,
}

/// Qué es lo último publicado, comparado con lo instalado.
pub fn checked(current: Version, latest: Result<Option<Version>, String>) -> Checked {
    match latest {
        Err(why) => Checked::Failed(why),
        Ok(None) => {
            Checked::Failed("La respuesta de GitHub no trae una versión que entienda.".into())
        }
        Ok(latest) => match newer(current, latest) {
            Some(v) => Checked::Newer(v),
            None => Checked::UpToDate(current),
        },
    }
}

/// El diálogo de "Buscar ahora": título y texto. Para una versión nueva, además se ofrece
/// actualizar (eso lo arma quien lo muestra).
pub fn manual_text(c: &Checked) -> (String, String) {
    match c {
        Checked::Newer(v) => (
            format!("Hay una versión nueva: v{v}"),
            format!("Actualizar reinicia la app y el server, y las sesiones se retoman solas. También podés actualizar más tarde desde {}.", policy::icon_place()),
        ),
        Checked::UpToDate(v) => (
            "Estás en la última versión".into(),
            format!("Tenés control-plane v{v}, la última publicada."),
        ),
        Checked::Failed(why) => (
            "No se pudieron buscar actualizaciones".into(),
            format!("{why} Probá de nuevo en un rato."),
        ),
        Checked::Off => (
            "La app de desarrollo no busca actualizaciones".into(),
            "Para probarlo, definí CONTROL_PLANE_UPDATE_URL.".into(),
        ),
    }
}

/// Por qué falló `curl`, en criollo (los códigos de `man curl`).
pub fn curl_failure(code: Option<i32>) -> String {
    match code {
        Some(6) | Some(7) => "No hay conexión con GitHub.".into(),
        Some(28) => "GitHub tardó demasiado en responder.".into(),
        Some(22) => "GitHub respondió con un error (puede ser el límite de consultas).".into(),
        Some(c) => format!("La consulta a GitHub falló (curl terminó con código {c})."),
        None => "La consulta a GitHub se cortó.".into(),
    }
}

/// Dónde navega "Reintentar" en la web: una URL de acción de la app con el token de esta falla.
pub const RETRY_PATH: &str = "/__action/update-retry";

pub fn retry_url(token: &str) -> String {
    let mut url = crate::screen::local_base()
        .join(RETRY_PATH.trim_start_matches('/'))
        .expect("URL válida");
    url.query_pairs_mut().append_pair("t", token);
    url.to_string()
}

/// El token de un pedido de "Reintentar" (sin validar todavía), o `None` si no es uno.
pub fn retry_token(url: &tauri::Url) -> Option<String> {
    if !crate::screen::is_action_url(url) || url.path() != RETRY_PATH {
        return None;
    }
    url.query_pairs()
        .find(|(k, _)| k == "t")
        .map(|(_, v)| v.into_owned())
}

// ---- Estado y bucle ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Available(Version),
    /// "Esperar a que terminen": se actualiza cuando no haya sesiones trabajando.
    Waiting(Version),
    Updating(Version),
}

enum Cmd {
    CheckNow,
    /// "Buscar ahora": aunque esté apagado, y avisando qué encontró.
    CheckManual,
    Update,
}

/// Estado de Tauri (`app.state::<Updater>()`).
pub struct Updater {
    tx: Mutex<Sender<Cmd>>,
    status: Arc<Mutex<Status>>,
    /// Tocar "Actualizando cuando terminen…" cancela la espera.
    cancel_wait: Arc<AtomicBool>,
    /// El token de "Reintentar" de la última falla (uno por falla, se gasta al usarlo).
    retry: Arc<Mutex<Option<String>>>,
}

impl Updater {
    pub fn status(&self) -> Status {
        *self.status.lock().unwrap()
    }
    /// Buscar ya (al prender "Buscar actualizaciones").
    pub fn check_now(&self) {
        let _ = self.tx.lock().unwrap().send(Cmd::CheckNow);
    }
    /// "Buscar ahora".
    pub fn check_manual(&self) {
        let _ = self.tx.lock().unwrap().send(Cmd::CheckManual);
    }
    /// "Reintentar" en "No se pudo actualizar" de la web: solo con el token de la última falla.
    pub fn retry(&self, token: &str) {
        let ok = {
            let mut slot = self.retry.lock().unwrap();
            let ok = !token.is_empty() && slot.as_deref() == Some(token);
            if ok {
                *slot = None;
            }
            ok
        };
        if ok {
            self.update();
        } else {
            eprintln!("Ignoro un \"Reintentar\" sin el token de la última falla.");
        }
    }
    /// Actualizar a la versión encontrada (desde la bandeja, el aviso o "Reintentar").
    pub fn update(&self) {
        if matches!(self.status(), Status::Waiting(_)) {
            self.cancel_wait.store(true, Ordering::SeqCst);
            return;
        }
        let _ = self.tx.lock().unwrap().send(Cmd::Update);
    }
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let (tx, rx) = mpsc::channel();
    let status = Arc::new(Mutex::new(Status::Idle));
    let cancel_wait = Arc::new(AtomicBool::new(false));
    let retry = Arc::new(Mutex::new(None));
    app.manage(Updater {
        tx: Mutex::new(tx),
        status: status.clone(),
        cancel_wait: cancel_wait.clone(),
        retry: retry.clone(),
    });
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("actualizaciones".into())
        .spawn(move || {
            let mut wait = FIRST_CHECK;
            loop {
                match rx.recv_timeout(wait) {
                    Ok(Cmd::Update) => {
                        run_update(&app, &status, &cancel_wait, &retry);
                        continue;
                    }
                    Ok(Cmd::CheckManual) => {
                        check_manual(&app, &status);
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

/// Lo último publicado según GitHub (o el server de prueba).
fn fetch_latest(url: &str, current: Version) -> Result<Option<Version>, String> {
    let out = Command::new(CURL)
        .args(curl_args(url, &current.to_string()))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("No se pudo ejecutar curl: {e}."))?;
    if !out.status.success() {
        return Err(curl_failure(out.status.code()));
    }
    if out.stdout.len() > MAX_RESPONSE {
        return Err("La respuesta de GitHub es demasiado grande.".into());
    }
    Ok(parse_latest(&String::from_utf8_lossy(&out.stdout)))
}

/// Consulta y, si hay una versión nueva, la ofrece en el menú y en el cartel de la web.
fn lookup<R: Runtime>(app: &AppHandle<R>, status: &Mutex<Status>, enabled: bool) -> Checked {
    let env_url = std::env::var("CONTROL_PLANE_UPDATE_URL").ok();
    let Some(url) = request_url(enabled, cfg!(debug_assertions), env_url.as_deref()) else {
        return Checked::Off;
    };
    let current = current_version(app);
    let found = checked(current, fetch_latest(&url, current));
    if let Checked::Newer(v) = found {
        {
            let mut st = status.lock().unwrap();
            if matches!(*st, Status::Updating(_) | Status::Waiting(_)) {
                return found;
            }
            *st = Status::Available(v);
        }
        eprintln!("Hay una versión nueva: v{v} (esta es v{current}).");
        show(app, Status::Available(v));
    }
    found
}

/// La consulta de cada día. Sin red, con rate limit o con error: nada, y se reintenta en el
/// próximo ciclo.
fn check<R: Runtime>(app: &AppHandle<R>, status: &Mutex<Status>) {
    let enabled = app.state::<AppState>().settings().check_updates;
    let Checked::Newer(v) = lookup(app, status, enabled) else {
        return;
    };
    if !matches!(*status.lock().unwrap(), Status::Available(_)) {
        return;
    }
    // Un solo aviso nativo por versión.
    let state = app.state::<AppState>();
    if should_announce(state.settings().update_notified.as_deref(), v) {
        state.update_settings(|s| s.update_notified = Some(v.to_string()));
        crate::notify::handle(
            app,
            Toast {
                level: "info".into(),
                title: format!("Hay una versión nueva de control-plane (v{v})"),
                body: Some(format!("Tocá para actualizar, o más tarde desde {} → Actualizar a v{v}. Las sesiones siguen abiertas.", policy::icon_place())),
                local: Some(Local::Update),
                ..Toast::default()
            },
        );
    }
}

/// "Buscar ahora": consulta aunque esté apagado y lo dice en un diálogo, haya o no versión nueva.
/// Con una nueva, el diálogo ofrece actualizar en el momento.
fn check_manual<R: Runtime>(app: &AppHandle<R>, status: &Mutex<Status>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if let Status::Updating(v) | Status::Waiting(v) = *status.lock().unwrap() {
        app.dialog()
            .message(format!("Ya se está actualizando a v{v}."))
            .title("Buscar actualizaciones")
            .kind(MessageDialogKind::Info)
            .blocking_show();
        return;
    }
    let found = lookup(app, status, true);
    let (title, message) = manual_text(&found);
    let dialog = app.dialog().message(message).title(title);
    match found {
        Checked::Newer(v) => {
            // Ya se vio: el aviso nativo de esta versión no hace falta.
            app.state::<AppState>()
                .update_settings(|s| s.update_notified = Some(v.to_string()));
            let update = dialog
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Actualizar ahora".into(),
                    "Más tarde".into(),
                ))
                .blocking_show();
            if update {
                run_update_now(app);
            }
        }
        Checked::Failed(_) => {
            dialog.kind(MessageDialogKind::Warning).blocking_show();
        }
        Checked::UpToDate(_) | Checked::Off => {
            dialog.kind(MessageDialogKind::Info).blocking_show();
        }
    }
}

/// "Actualizar ahora" desde el hilo de las actualizaciones (el diálogo corre ahí): se encola como
/// cualquier otro pedido.
fn run_update_now<R: Runtime>(app: &AppHandle<R>) {
    if let Some(u) = app.try_state::<Updater>() {
        u.update();
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

/// Cuántas líneas del log le llegan a la web (lo último, que es donde está el motivo).
const LOG_TAIL_LINES: usize = 40;

fn log_tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n")
}

/// El JS que le cuenta a la página que la actualización falló (el motivo, dónde está el log y lo
/// último que dice). Va como JSON: el texto del log nunca se interpreta como código.
pub fn failure_script(v: Version, why: &str, log: &Path, tail: &str, retry: &str) -> String {
    let info = serde_json::json!({
        "version": v.to_string(),
        "error": why,
        "logPath": log.to_string_lossy(),
        "log": tail,
        "retryUrl": retry_url(retry),
    });
    let json = info
        .to_string()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("window.__cpDesktop?.updateFailed?.({json})")
}

/// Además del aviso del sistema, la página lo muestra como toast (con "Ver log", y ahí
/// "Reintentar" y "Copiar log").
fn push_failure<R: Runtime>(
    app: &AppHandle<R>,
    v: Version,
    why: &str,
    log: &Path,
    tail: &str,
    retry: &Mutex<Option<String>>,
) {
    let token = crate::screen::random_hex();
    *retry.lock().unwrap() = Some(token.clone());
    if let Some(w) = app.get_webview_window(crate::window::MAIN) {
        let _ = w.eval(failure_script(v, why, log, tail, &token));
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
fn run_update<R: Runtime>(
    app: &AppHandle<R>,
    status: &Mutex<Status>,
    cancel: &AtomicBool,
    retry: &Mutex<Option<String>>,
) {
    let Status::Available(v) = *status.lock().unwrap() else {
        return;
    };
    // Actualizar reinicia el server: si hay sesiones trabajando, antes se pregunta.
    if let UpdateStart::Ask { working } = policy::update_start(working_sessions(app)) {
        match ask_update(app, working) {
            UpdateChoice::Now => {}
            UpdateChoice::Cancel => return,
            UpdateChoice::Wait => {
                if !wait_until_idle(app, status, v, cancel) {
                    return;
                }
            }
        }
    }
    {
        let mut st = status.lock().unwrap();
        if *st != Status::Available(v) && *st != Status::Waiting(v) {
            return;
        }
        *st = Status::Updating(v);
    }
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
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        push_failure(app, v, &why, &log, &log_tail(&text), retry);
        crate::notify::handle(
            app,
            Toast {
                level: "error".into(),
                title: "No se pudo actualizar control-plane".into(),
                body: Some(format!("{why} Tocá para ver el log.")),
                local: Some(Local::OpenLog(log)),
                ..Toast::default()
            },
        );
    }
}

/// Cuántas sesiones están trabajando, según el último resumen del server (0 si no se sabe).
fn working_sessions<R: Runtime>(app: &AppHandle<R>) -> u32 {
    app.try_state::<crate::desktop_ws::DesktopWs>()
        .and_then(|ws| ws.snapshot().summary.map(|s| s.working))
        .unwrap_or(0)
}

enum UpdateChoice {
    Wait,
    Now,
    Cancel,
}

fn ask_update<R: Runtime>(app: &AppHandle<R>, working: u32) -> UpdateChoice {
    use tauri_plugin_dialog::{
        DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
    };
    let (wait, now, cancel) = ("Esperar a que terminen", "Actualizar ahora", "Cancelar");
    let result = app
        .dialog()
        .message(policy::update_question(working))
        .title("Actualizar control-plane")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            wait.into(),
            now.into(),
            cancel.into(),
        ))
        .blocking_show_with_result();
    match result {
        MessageDialogResult::Yes => UpdateChoice::Wait,
        MessageDialogResult::No => UpdateChoice::Now,
        MessageDialogResult::Custom(s) if s == wait => UpdateChoice::Wait,
        MessageDialogResult::Custom(s) if s == now => UpdateChoice::Now,
        _ => UpdateChoice::Cancel,
    }
}

/// "Esperar a que terminen": hasta que no haya sesiones trabajando, con tope. Devuelve false si
/// se canceló (tocando "Actualizando cuando terminen…" en el menú).
fn wait_until_idle<R: Runtime>(
    app: &AppHandle<R>,
    status: &Mutex<Status>,
    v: Version,
    cancel: &AtomicBool,
) -> bool {
    cancel.store(false, Ordering::SeqCst);
    *status.lock().unwrap() = Status::Waiting(v);
    show(app, Status::Waiting(v));
    let until = std::time::Instant::now() + policy::WAIT_FOR_IDLE;
    loop {
        if cancel.swap(false, Ordering::SeqCst) {
            *status.lock().unwrap() = Status::Available(v);
            show(app, Status::Available(v));
            return false;
        }
        if working_sessions(app) == 0 {
            return true;
        }
        if std::time::Instant::now() >= until {
            eprintln!("Pasaron {} min y siguen sesiones trabajando: actualizo igual (se retoman después).", policy::WAIT_FOR_IDLE.as_secs() / 60);
            return true;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// Lo que la app le suma al server para lanzarlo, y que el instalador no tiene que heredar.
const NOT_FOR_INSTALLER: &[&str] = &[
    "NODE_ENV",
    "npm_config_allow_scripts",
    "CONTROL_PLANE_HOST",
    "CONTROL_PLANE_LAUNCH_ID",
    "CONTROL_PLANE_WEB_DIST",
    "CONTROL_PLANE_COMPACT_HOOK",
];

/// El entorno del instalador: el mismo que el server (el de la app sin lo de Claude Code, lo de la
/// shell de login y el PATH combinado), sin lo propio del server, y con el `node` que ya resolvió
/// la app en `CONTROL_PLANE_NODE`. Abierta desde el lanzador, la app no tiene el PATH de tu shell:
/// sin esto, `get.sh` no veía el node de nvm. Lo gráfico (`DISPLAY`, `WAYLAND_DISPLAY`,
/// `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`), que pkexec y su agente necesitan, viene de la app.
pub fn installer_env(
    server_env: &BTreeMap<String, String>,
    node: Option<&Path>,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = server_env
        .iter()
        .filter(|(k, _)| !NOT_FOR_INSTALLER.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Some(node) = node {
        env.insert(
            "CONTROL_PLANE_NODE".into(),
            node.to_string_lossy().into_owned(),
        );
    }
    env
}

fn spawn_installer<R: Runtime>(
    app: &AppHandle<R>,
    v: Version,
    log: &Path,
) -> Result<std::process::Child, String> {
    let script = script_path(app);
    if !script.is_file() {
        return Err(format!(
            "No se encontró el instalador ({}).",
            script.display()
        ));
    }
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let launch = LaunchEnv::prepare(&app.state::<AppState>().settings());
    let env = installer_env(
        &launch.server_env,
        launch.node.as_ref().ok().map(|n| n.path.as_path()),
    );
    let mut out = std::fs::File::create(log).map_err(|e| e.to_string())?;
    // Primero, con qué entorno corre (sin valores de variables): si no encuentra algo, se ve acá.
    let _ = writeln!(out, "{}", launch.summary());
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let args = installer_args(&script, v, std::process::id(), &install_kind(app));
    eprintln!(
        "Actualizo a v{v}: bash {:?} (log en {})",
        args,
        log.display()
    );
    let mut cmd = Command::new(BASH);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .env_clear()
        .envs(&env);
    if let Some((k, v)) = installer_locale() {
        cmd.env(k, v);
    }
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
        .map_err(|e| format!("No se pudo lanzar el instalador: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn installer_env_has_the_login_path_and_the_node_and_nothing_internal() {
        use crate::login_env::{server_env, LoginEnv};
        let app_env = [
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/u"),
            ("DISPLAY", ":0"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("NODE_ENV", "production"),
            ("CLAUDECODE", "1"),
            ("CONTROL_PLANE_LAUNCH_ID", "abc"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let login = LoginEnv {
            shell: "/bin/bash".into(),
            elapsed: Duration::ZERO,
            vars: [(
                "PATH".to_string(),
                "/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin".to_string(),
            )]
            .into(),
            error: None,
        };
        let path =
            crate::login_env::merge_path(login.get("PATH"), Some("/usr/bin:/bin"), &[], |_| true);
        let server = server_env(app_env, &login, &path);
        let node = Path::new("/home/u/.nvm/versions/node/v24.1.0/bin/node");
        let env = installer_env(&server, Some(node));
        assert_eq!(
            env["PATH"], "/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin",
            "el PATH de la shell de login, primero"
        );
        assert_eq!(env["CONTROL_PLANE_NODE"], node.to_string_lossy());
        for keep in [
            "HOME",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ] {
            assert!(
                env.contains_key(keep),
                "falta {keep} (pkexec y su agente lo necesitan)"
            );
        }
        for gone in ["NODE_ENV", "CLAUDECODE", "CONTROL_PLANE_LAUNCH_ID"] {
            assert!(!env.contains_key(gone), "{gone} no es para el instalador");
        }
        assert!(!installer_env(&server, None).contains_key("CONTROL_PLANE_NODE"));
    }

    #[test]
    fn failure_reaches_the_page_as_json() {
        let js = failure_script(
            Version(0, 3, 2),
            "No encuentro Node.",
            Path::new("/home/u/.local/share/x/logs/update.log"),
            "línea 1\n✗ No encuentro Node. \")</script>\u{2028}",
            "abc123",
        );
        let json = js
            .strip_prefix("window.__cpDesktop?.updateFailed?.(")
            .and_then(|r| r.strip_suffix(')'))
            .expect("la llamada");
        assert!(!json.contains('\u{2028}'));
        let v: serde_json::Value = serde_json::from_str(json).expect("JSON");
        assert_eq!(v["version"], "0.3.2");
        assert_eq!(v["error"], "No encuentro Node.");
        assert_eq!(v["logPath"], "/home/u/.local/share/x/logs/update.log");
        assert!(v["log"].as_str().unwrap().ends_with("</script>\u{2028}"));
        let retry = tauri::Url::parse(v["retryUrl"].as_str().unwrap()).unwrap();
        assert_eq!(retry_token(&retry).as_deref(), Some("abc123"));
    }

    #[test]
    fn retry_only_from_the_app_url() {
        let ok = tauri::Url::parse(&retry_url("t0k")).unwrap();
        assert_eq!(retry_token(&ok).as_deref(), Some("t0k"));
        for bad in [
            "http://127.0.0.1:4700/__action/update-retry?t=t0k",
            "tauri://localhost/__action/retry?t=t0k",
            "tauri://localhost/__action/update-retry/x?t=t0k",
        ] {
            assert_eq!(retry_token(&tauri::Url::parse(bad).unwrap()), None, "{bad}");
        }
    }

    #[test]
    fn manual_check_always_says_something() {
        let cur = Version(0, 5, 0);
        assert_eq!(
            checked(cur, Ok(Some(Version(0, 6, 0)))),
            Checked::Newer(Version(0, 6, 0))
        );
        assert_eq!(checked(cur, Ok(Some(cur))), Checked::UpToDate(cur));
        assert_eq!(
            checked(cur, Ok(Some(Version(0, 4, 9)))),
            Checked::UpToDate(cur)
        );
        assert!(matches!(checked(cur, Ok(None)), Checked::Failed(_)));
        assert_eq!(checked(cur, Err("x".into())), Checked::Failed("x".into()));
        assert_eq!(
            manual_text(&Checked::UpToDate(cur)).0,
            "Estás en la última versión"
        );
        assert!(manual_text(&Checked::UpToDate(cur)).1.contains("v0.5.0"));
        assert_eq!(
            manual_text(&Checked::Newer(Version(0, 6, 0))).0,
            "Hay una versión nueva: v0.6.0"
        );
        assert_eq!(curl_failure(Some(6)), "No hay conexión con GitHub.");
        assert!(curl_failure(Some(35)).contains("código 35"));
    }

    #[test]
    fn log_tail_keeps_the_last_lines() {
        let text: String = (1..=100).map(|i| format!("l{i}\n")).collect();
        let tail = log_tail(&text);
        assert!(
            tail.starts_with("l61\n") && tail.ends_with("l100"),
            "{tail}"
        );
    }

    #[test]
    fn installer_runs_with_c_locale_on_the_mac() {
        if cfg!(target_os = "macos") {
            assert_eq!(installer_locale(), Some(("LC_ALL", "C")));
        } else {
            assert_eq!(installer_locale(), None);
        }
    }

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
        // En release la variable no cuenta: siempre GitHub.
        assert_eq!(
            check_url(false, Some("https://otro.example/latest")).as_deref(),
            Some(api)
        );
        assert_eq!(
            check_url(false, Some("http://127.0.0.1:1/x")).as_deref(),
            Some(api)
        );
        // http solo a esta máquina.
        assert_eq!(check_url(true, Some("http://evil.example/latest")), None);
        assert_eq!(check_url(true, Some("file:///etc/passwd")), None);
    }

    #[test]
    fn nothing_is_asked_with_the_setting_off() {
        assert_eq!(request_url(false, false, None), None);
        assert_eq!(request_url(false, false, Some("https://x.example/y")), None);
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
        let out = Command::new(CURL)
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
