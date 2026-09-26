//! La ventana principal: muestra el dashboard que sirve el server en `http://127.0.0.1:<puerto>/`.
//!
//! La página es remota para Tauri y no tiene IPC (capabilities vacías). La app le habla solo con
//! `initialization_script` y `eval`; la ventana no puede salir de `127.0.0.1:<puerto>`: cualquier
//! otro link se abre en el navegador del sistema.

use std::fmt;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use tauri::webview::NewWindowResponse;

use crate::screen::{self, Screen};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const DEFAULT_PORT: u16 = 4700;
pub const DEV_DEFAULT_PORT: u16 = 4710;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortError {
    /// `CONTROL_PLANE_PORT` no es un puerto válido.
    Invalid(String),
    /// En desarrollo, el 4700 es el del dashboard de todos los días.
    Reserved(u16),
}

impl fmt::Display for PortError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(v) => write!(f, "CONTROL_PLANE_PORT=\"{v}\" no es un puerto válido."),
            Self::Reserved(p) => write!(
                f,
                "La app de desarrollo no usa el puerto {p}, el del dashboard de todos los días. \
                 Usá otro (CONTROL_PLANE_PORT=4710) o definí CONTROL_PLANE_ALLOW_4700=1."
            ),
        }
    }
}

/// De dónde sale el puerto: `CONTROL_PLANE_PORT` del entorno de la app, si no el de la shell de
/// login (el de tu `.zshrc`), si no los ajustes, si no el de siempre.
/// En desarrollo el de siempre es 4710 y el 4700 se rechaza salvo que se permita a propósito.
pub fn resolve_port(
    env_port: Option<&str>,
    login_port: Option<&str>,
    settings_port: Option<u16>,
    debug: bool,
    allow_4700: bool,
) -> Result<u16, PortError> {
    let port = match given(env_port).or(given(login_port)) {
        Some(v) => match v.parse::<u16>() {
            Ok(p) if p != 0 => p,
            _ => return Err(PortError::Invalid(v.to_string())),
        },
        None => settings_port.unwrap_or(if debug {
            DEV_DEFAULT_PORT
        } else {
            DEFAULT_PORT
        }),
    };
    if debug && port == DEFAULT_PORT && !allow_4700 {
        return Err(PortError::Reserved(port));
    }
    Ok(port)
}

fn given(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|v| !v.is_empty())
}

/// Lee el puerto del entorno, de la shell de login y de los ajustes, según el tipo de build.
pub fn port_from_env(
    login_port: Option<&str>,
    settings_port: Option<u16>,
) -> Result<u16, PortError> {
    let env_port = std::env::var("CONTROL_PLANE_PORT").ok();
    let allow = std::env::var("CONTROL_PLANE_ALLOW_4700").is_ok_and(|v| v == "1");
    resolve_port(
        env_port.as_deref(),
        login_port,
        settings_port,
        cfg!(debug_assertions),
        allow,
    )
}

pub fn server_url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/")).expect("URL válida")
}

/// La pantalla local de la app (carga y errores), servida por Tauri.
fn is_local_app(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        // Windows y Android sirven la app en http://tauri.localhost.
        "http" | "https" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    }
}

/// Qué hacer con una navegación de la ventana.
#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    Allow,
    /// No se navega; se abre en el navegador del sistema.
    External,
    Block,
}

pub fn classify(url: &Url, port: u16) -> Nav {
    let dashboard = port != 0
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none();
    if dashboard || is_local_app(url) || url.as_str() == "about:blank" {
        return Nav::Allow;
    }
    match url.scheme() {
        "http" | "https" | "mailto" => Nav::External,
        _ => Nav::Block,
    }
}

fn open_external(url: &Url) {
    if let Err(err) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("No pude abrir {url} en el navegador: {err}");
    }
}

/// Lo que ve la web antes de cargar: que está dentro de la app, y en qué versión.
fn init_script<R: Runtime>(app: &AppHandle<R>) -> String {
    let info = serde_json::json!({ "version": app.package_info().version.to_string() });
    format!("window.__CONTROL_PLANE_DESKTOP__ = Object.freeze({info});")
}

/// Crea la ventana principal con la pantalla local de carga. `port` es el puerto del dashboard
/// al que se deja navegar: 0 mientras no se sabe (y entonces ningún `127.0.0.1` pasa). Los
/// pedidos de la pantalla local (`/__action/…` con el token de esta corrida) van a `on_action`.
pub fn create_main<R: Runtime>(
    app: &AppHandle<R>,
    port: Arc<AtomicU16>,
    token: String,
    on_action: impl Fn(screen::Request) + Send + Sync + 'static,
) -> tauri::Result<WebviewWindow<R>> {
    let first = Screen::loading().url(&token);
    let start = WebviewUrl::App(format!("index.html?{}", first.query().unwrap_or_default()).into());

    WebviewWindowBuilder::new(app, MAIN, start)
        .title("control-plane")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        // Al iniciar sesión arranca escondida: solo la bandeja.
        .visible(!crate::startup::started_hidden())
        .initialization_script(init_script(app))
        .on_navigation(move |url| {
            // Los botones de la pantalla local: nunca se navega, y solo valen con el token.
            if screen::is_action_url(url) {
                if let Some(req) = screen::parse_action(url, &token) {
                    on_action(req);
                }
                return false;
            }
            match classify(url, port.load(Ordering::SeqCst)) {
                Nav::Allow => true,
                Nav::External => {
                    open_external(url);
                    false
                }
                Nav::Block => false,
            }
        })
        .on_new_window(|url, _features| {
            // target=_blank y window.open: nunca otra ventana de la app; los links web van al
            // navegador (también los del propio dashboard, que así se abren en una pestaña).
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                open_external(&url);
            }
            NewWindowResponse::Deny
        })
        .build()
}

/// Lleva la ventana a una pantalla local.
pub fn show_screen<R: Runtime>(app: &AppHandle<R>, s: &Screen, token: &str) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.navigate(s.url(token));
    }
}

/// Lleva la ventana al dashboard (la guarda ya tiene que tener este puerto).
pub fn show_dashboard<R: Runtime>(app: &AppHandle<R>, port: u16) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.navigate(server_url(port));
    }
}

/// Abre una URL en el navegador del sistema.
pub fn open_in_browser(url: &str) {
    if let Ok(u) = Url::parse(url) {
        open_external(&u);
    }
}

/// Muestra la ventana principal y le da foco (desde la bandeja, otra instancia o una notificación).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    show_main_with(app, None);
}

/// Como [`show_main`], con el token de activación de quien la pidió (una segunda apertura o el clic
/// en una notificación): GNOME en Wayland solo le da foco a una ventana con token. Linux, y en el
/// hilo principal (GTK).
pub fn show_main_with<R: Runtime>(app: &AppHandle<R>, _token: Option<&str>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        #[cfg(target_os = "linux")]
        if let (Some(token), Ok(gtk)) = (_token, w.gtk_window()) {
            use gtk::prelude::GtkWindowExt;
            gtk.set_startup_id(token);
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Una ruta interna del dashboard (`/p/<id>`, `/p/<id>/s/<id>`); nada de URLs ni `//host`.
pub fn is_route(href: &str) -> bool {
    href.starts_with('/')
        && !href.starts_with("//")
        && !href.contains('\\')
        && !href.chars().any(char::is_control)
}

/// Muestra la ventana y lleva el dashboard a `href` sin recargar (lo resuelve la web con
/// `window.__cpDesktop.open`). Lo usan el clic en una notificación y el menú de proyectos.
pub fn open_route<R: Runtime>(app: &AppHandle<R>, href: &str) -> bool {
    if !is_route(href) {
        return false;
    }
    show_main(app);
    let Some(w) = app.get_webview_window(MAIN) else {
        return false;
    };
    let arg = serde_json::to_string(href).expect("un string siempre se serializa");
    w.eval(format!("window.__cpDesktop?.open({arg})")).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn port_sources_in_order() {
        assert_eq!(
            resolve_port(Some("4800"), None, Some(4900), false, false),
            Ok(4800)
        );
        assert_eq!(resolve_port(None, None, Some(4900), false, false), Ok(4900));
        assert_eq!(resolve_port(None, None, None, false, false), Ok(4700));
        assert_eq!(resolve_port(None, None, None, true, false), Ok(4710));
        assert_eq!(resolve_port(Some("  "), None, None, true, false), Ok(4710));
    }

    #[test]
    fn login_port_comes_after_the_app_env() {
        assert_eq!(
            resolve_port(None, Some("4712"), Some(4900), false, false),
            Ok(4712)
        );
        assert_eq!(
            resolve_port(Some("4711"), Some("4712"), None, false, false),
            Ok(4711)
        );
        assert_eq!(
            resolve_port(Some(" "), Some("4712"), None, true, false),
            Ok(4712)
        );
        assert!(matches!(
            resolve_port(None, Some("x"), None, false, false),
            Err(PortError::Invalid(_))
        ));
        assert_eq!(
            resolve_port(None, Some("4700"), None, true, false),
            Err(PortError::Reserved(4700))
        );
    }

    #[test]
    fn invalid_env_port_is_an_error() {
        for v in ["abc", "0", "70000", "-1", "4710x"] {
            assert!(
                matches!(
                    resolve_port(Some(v), None, None, false, false),
                    Err(PortError::Invalid(_))
                ),
                "{v}"
            );
        }
    }

    #[test]
    fn debug_refuses_4700_unless_allowed() {
        assert_eq!(
            resolve_port(Some("4700"), None, None, true, false),
            Err(PortError::Reserved(4700))
        );
        assert_eq!(
            resolve_port(None, None, Some(4700), true, false),
            Err(PortError::Reserved(4700))
        );
        assert_eq!(resolve_port(Some("4700"), None, None, true, true), Ok(4700));
        assert_eq!(
            resolve_port(Some("4700"), None, None, false, false),
            Ok(4700)
        );
    }

    #[test]
    fn only_the_exact_dashboard_origin_is_allowed() {
        assert_eq!(classify(&url("http://127.0.0.1:4710/"), 4710), Nav::Allow);
        assert_eq!(
            classify(&url("http://127.0.0.1:4710/p/a/s/b?x=1#y"), 4710),
            Nav::Allow
        );
        assert_eq!(
            classify(&url("tauri://localhost/index.html"), 4710),
            Nav::Allow
        );
        assert_eq!(classify(&url("about:blank"), 4710), Nav::Allow);
        // Otros puertos, hosts y variantes van al navegador (no a la ventana).
        for s in [
            "http://127.0.0.1:4700/",
            "http://127.0.0.1/",
            "http://localhost:4710/",
            "http://[::1]:4710/",
            "https://127.0.0.1:4710/",
            "http://127.0.0.1.evil.com:4710/",
            "http://user:pw@127.0.0.1:4710/",
            "http://tauri.localhost:4710/",
            "https://docs.claude.com/",
        ] {
            assert_eq!(classify(&url(s), 4710), Nav::External, "{s}");
        }
        for s in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "tauri://evil/index.html",
            "ftp://127.0.0.1:4710/",
        ] {
            assert_eq!(classify(&url(s), 4710), Nav::Block, "{s}");
        }
    }

    #[test]
    fn host_with_port_lookalikes_do_not_even_parse() {
        assert!(Url::parse("http://127.0.0.1:4710.evil.com/").is_err());
    }

    #[test]
    fn no_port_means_no_dashboard() {
        assert_eq!(classify(&url("http://127.0.0.1:4710/"), 0), Nav::External);
        assert_eq!(classify(&url("http://127.0.0.1:0/"), 0), Nav::External);
    }

    #[test]
    fn routes_are_internal_paths_only() {
        assert!(is_route("/p/abc/s/def"));
        assert!(is_route("/"));
        for s in [
            "",
            "p/abc",
            "//evil.com",
            "/\\evil.com",
            "http://x",
            "/a\nb",
            "javascript:x",
        ] {
            assert!(!is_route(s), "{s:?}");
        }
    }
}
