//! La ventana principal: muestra el dashboard que sirve el server en `http://127.0.0.1:<puerto>/`.
//!
//! La página es remota para Tauri y no tiene IPC (capabilities vacías). La app le habla solo con
//! `initialization_script` y `eval`; la ventana no puede salir de `127.0.0.1:<puerto>`: cualquier
//! otro link se abre en el navegador del sistema.

use std::fmt;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use tauri::webview::NewWindowResponse;
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

/// De dónde sale el puerto: `CONTROL_PLANE_PORT`, si no los ajustes, si no el de siempre.
/// En desarrollo el de siempre es 4710 y el 4700 se rechaza salvo que se permita a propósito.
pub fn resolve_port(
    env_port: Option<&str>,
    settings_port: Option<u16>,
    debug: bool,
    allow_4700: bool,
) -> Result<u16, PortError> {
    let port = match env_port.map(str::trim).filter(|v| !v.is_empty()) {
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

/// Lee el puerto del entorno y de los ajustes, según el tipo de build.
pub fn port_from_env(settings_port: Option<u16>) -> Result<u16, PortError> {
    let env_port = std::env::var("CONTROL_PLANE_PORT").ok();
    let allow = std::env::var("CONTROL_PLANE_ALLOW_4700").is_ok_and(|v| v == "1");
    resolve_port(
        env_port.as_deref(),
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
    let dashboard = url.scheme() == "http"
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

/// La pantalla local de error o de carga, con lo que necesita para reintentar.
pub fn error_url(port: Option<u16>, reason: &str, detail: Option<&str>) -> WebviewUrl {
    let mut url = Url::parse("app://local/index.html").expect("URL válida");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("reason", reason);
        if let Some(p) = port {
            q.append_pair("port", &p.to_string());
        }
        if let Some(d) = detail {
            q.append_pair("detail", d);
        }
    }
    let path = format!("index.html?{}", url.query().unwrap_or_default());
    WebviewUrl::App(path.into())
}

/// ¿Hay algo escuchando en el puerto? (el chequeo fino con /api/health lo hace el sidecar).
pub fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// Crea la ventana principal. Con `port = Err`, muestra el error y no navega a ningún server.
pub fn create_main<R: Runtime>(
    app: &AppHandle<R>,
    port: Result<u16, PortError>,
) -> tauri::Result<WebviewWindow<R>> {
    let (start, guard_port) = match &port {
        Ok(p) if port_open(*p) => (WebviewUrl::External(server_url(*p)), Some(*p)),
        Ok(p) => (error_url(Some(*p), "no-server", None), Some(*p)),
        Err(e) => (error_url(None, "port", Some(&e.to_string())), None),
    };
    // Sin puerto válido no hay dashboard al que navegar: 0 nunca coincide.
    let guard = guard_port.unwrap_or(0);
    eprintln!("Ventana: abro {start}");

    WebviewWindowBuilder::new(app, MAIN, start)
        .title("control-plane")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(init_script(app))
        .on_navigation(move |url| match classify(url, guard) {
            Nav::Allow => true,
            Nav::External => {
                open_external(url);
                false
            }
            Nav::Block => false,
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

/// Muestra la ventana principal y le da foco (desde la bandeja, otra instancia o una notificación).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
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
            resolve_port(Some("4800"), Some(4900), false, false),
            Ok(4800)
        );
        assert_eq!(resolve_port(None, Some(4900), false, false), Ok(4900));
        assert_eq!(resolve_port(None, None, false, false), Ok(4700));
        assert_eq!(resolve_port(None, None, true, false), Ok(4710));
        assert_eq!(resolve_port(Some("  "), None, true, false), Ok(4710));
    }

    #[test]
    fn invalid_env_port_is_an_error() {
        for v in ["abc", "0", "70000", "-1", "4710x"] {
            assert!(
                matches!(
                    resolve_port(Some(v), None, false, false),
                    Err(PortError::Invalid(_))
                ),
                "{v}"
            );
        }
    }

    #[test]
    fn debug_refuses_4700_unless_allowed() {
        assert_eq!(
            resolve_port(Some("4700"), None, true, false),
            Err(PortError::Reserved(4700))
        );
        assert_eq!(
            resolve_port(None, Some(4700), true, false),
            Err(PortError::Reserved(4700))
        );
        assert_eq!(resolve_port(Some("4700"), None, true, true), Ok(4700));
        assert_eq!(resolve_port(Some("4700"), None, false, false), Ok(4700));
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

    #[test]
    fn error_url_carries_reason_and_port() {
        let WebviewUrl::App(p) = error_url(Some(4710), "no-server", Some("a b&c")) else {
            panic!("tiene que ser una URL de la app");
        };
        let s = p.to_string_lossy().to_string();
        assert!(
            s.starts_with("index.html?reason=no-server&port=4710&detail="),
            "{s}"
        );
        assert!(!s.contains(' ') && !s.contains("&c"), "{s}");
    }
}
