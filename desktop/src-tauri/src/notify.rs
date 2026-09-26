//! Notificaciones nativas con cada `toast` del server.
//!
//! Solo con los avisos prendidos y la ventana escondida o sin foco: con la ventana al frente, la
//! página ya muestra el toast. El clic muestra la ventana y la lleva a lo que avisaba
//! (`window.__cpDesktop.open`, con los campos del toast tal cual).
//!
//! - Linux: D-Bus directo (`org.freedesktop.Notifications`, con zbus, que ya trae Tauri). Así se
//!   reemplaza el aviso anterior de la misma sesión (`replaces_id`) y se recibe el token de
//!   activación (`ActivationToken`) que GNOME en Wayland pide para darle foco a la ventana.
//! - macOS: `mac-notification-sys` (`NSUserNotification`). Está deprecada, pero anda sin firma ni
//!   bundle (también en `tauri dev`) y avisa del clic. `UNUserNotificationCenter` exige un `.app`
//!   firmado con bundle id. No reemplaza avisos: cada uno queda por separado.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::desktop_ws::Toast;
use crate::window;
use crate::AppState;

/// ¿Mandar el aviso del sistema? Con la ventana visible y con foco, ya lo muestra la página.
pub fn should_notify(enabled: bool, visible: bool, focused: bool) -> bool {
    enabled && !(visible && focused)
}

/// Los avisos de una misma sesión (o proyecto) se reemplazan entre sí.
pub fn group_key(t: &Toast) -> String {
    match (&t.session_id, &t.project_id) {
        (Some(s), _) => format!("session:{s}"),
        (None, Some(p)) => format!("project:{p}"),
        (None, None) => "general".into(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Target<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    open: Option<&'a str>,
}

/// El JS que lleva la página a lo que avisaba el toast, o `None` si no apunta a nada.
/// Va JSON (los textos del server nunca se interpretan como código), sin título ni cuerpo.
pub fn open_script(t: &Toast) -> Option<String> {
    if t.project_id.is_none() && t.session_id.is_none() {
        return None;
    }
    let target = Target {
        project_id: t.project_id.as_deref(),
        session_id: t.session_id.as_deref(),
        open: t.open.as_deref(),
    };
    let json = serde_json::to_string(&target)
        .expect("se serializa siempre")
        // JSON válido pero, en motores viejos, fin de línea dentro de un string de JS.
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Some(format!("window.__cpDesktop?.open({json})"))
}

/// Con qué `.desktop` se asocian los avisos y el contador del dock. La app de desarrollo usa otro
/// nombre, así sus avisos no suman al ícono de la app instalada.
pub fn desktop_id() -> &'static str {
    if cfg!(debug_assertions) {
        "control-plane-dev"
    } else {
        "control-plane"
    }
}

/// El clic en un aviso: ventana al frente (con el token de activación, si vino) y a lo que avisaba.
/// Después se cierran los avisos que quedaron: ya se vieron (y el dock deja de contarlos). El token
/// se usa antes, en el mismo turno del hilo principal.
fn on_click<R: Runtime>(app: &AppHandle<R>, toast: Toast, token: Option<String>) {
    eprintln!(
        "Clic en un aviso ({} token de activación).",
        if token.is_some() { "con" } else { "sin" }
    );
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        window::show_main_with(&handle, token.as_deref());
        if let (Some(js), Some(w)) = (open_script(&toast), handle.get_webview_window(window::MAIN))
        {
            let _ = w.eval(js);
        }
        dismiss_all(&handle);
    });
}

/// Cierra los avisos de la app que siguen en la lista del sistema (al tocar uno o cuando la
/// ventana gana el foco, como los navegadores). No bloquea: las llamadas van en otro hilo.
pub fn dismiss_all<R: Runtime>(_app: &AppHandle<R>) {
    #[cfg(target_os = "linux")]
    if let Some(n) = _app.try_state::<Notifier>() {
        let inner = n.inner.clone();
        std::thread::spawn(move || {
            if let Some(linux) = inner.get() {
                linux.dismiss_all();
            }
        });
    }
}

/// Estado de Tauri: el canal a las notificaciones del sistema.
pub struct Notifier {
    /// Se conecta al bus en un hilo aparte, para no demorar el arranque.
    #[cfg(target_os = "linux")]
    inner: std::sync::Arc<std::sync::OnceLock<linux::Linux>>,
    #[cfg(target_os = "macos")]
    inner: macos::Mac,
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "linux")]
    let inner = {
        let cell = std::sync::Arc::new(std::sync::OnceLock::new());
        let (handle, slot) = (app.clone(), cell.clone());
        std::thread::spawn(move || {
            match linux::Linux::new(move |toast, token| on_click(&handle, toast, token)) {
                Ok(n) => {
                    let _ = slot.set(n);
                }
                Err(e) => eprintln!("Sin notificaciones del sistema: {e}"),
            }
        });
        cell
    };
    #[cfg(target_os = "macos")]
    let inner = {
        let handle = app.clone();
        macos::Mac::new(&app.package_info().name, move |toast| {
            on_click(&handle, toast, None)
        })
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    app.manage(Notifier { inner });
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = app;
}

/// Un toast del server: aviso del sistema si corresponde.
pub fn handle<R: Runtime>(app: &AppHandle<R>, toast: Toast) {
    let enabled = app.state::<AppState>().settings().notifications;
    let win = app.get_webview_window(window::MAIN);
    let visible = win.as_ref().and_then(|w| w.is_visible().ok()) == Some(true);
    let focused = win.as_ref().and_then(|w| w.is_focused().ok()) == Some(true);
    if !should_notify(enabled, visible, focused) {
        return;
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    if let Some(n) = app.try_state::<Notifier>() {
        #[cfg(target_os = "linux")]
        if let Some(inner) = n.inner.get() {
            if let Err(e) = inner.show(toast) {
                eprintln!("No pude mostrar el aviso: {e}");
            }
        }
        #[cfg(target_os = "macos")]
        n.inner.show(toast);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = toast;
}

/// Escapa el cuerpo para servidores que interpretan markup (`body-markup`).
pub fn escape_markup(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use zbus::blocking::{proxy, Connection, Proxy};
    use zbus::proxy::CacheProperties;
    use zbus::zvariant::Value;

    use super::{escape_markup, group_key};
    use crate::desktop_ws::Toast;

    const DEST: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";

    #[derive(Default)]
    struct Book {
        /// Grupo → id del aviso vivo (para reemplazarlo).
        by_group: HashMap<String, u32>,
        /// id → el toast y el token de activación, si ya llegó.
        live: HashMap<u32, (Toast, Option<String>)>,
        /// Tocados: GNOME ya los saca, pero otros demonios los dejan en la lista.
        clicked: Vec<u32>,
    }

    pub struct Linux {
        proxy: Proxy<'static>,
        markup: bool,
        book: Arc<Mutex<Book>>,
    }

    impl Linux {
        pub fn new(
            on_click: impl Fn(Toast, Option<String>) + Send + 'static,
        ) -> zbus::Result<Self> {
            let conn = Connection::session()?;
            let proxy: Proxy<'static> = proxy::Builder::new(&conn)
                .destination(DEST)?
                .path(PATH)?
                .interface(DEST)?
                .cache_properties(CacheProperties::No)
                .build()?;
            let caps: Vec<String> = proxy.call("GetCapabilities", &())?;
            let markup = caps.iter().any(|c| c == "body-markup");
            // Las señales van a la conexión que mandó el aviso: se escuchan antes del primero.
            let signals = proxy.receive_all_signals()?;
            let book = Arc::new(Mutex::new(Book::default()));
            let listen = book.clone();
            std::thread::Builder::new()
                .name("avisos".into())
                .spawn(move || {
                    for msg in signals {
                        let header = msg.header();
                        let Some(member) = header.member() else {
                            continue;
                        };
                        let body = msg.body();
                        let mut book = listen.lock().unwrap();
                        match member.as_str() {
                            // Llega antes que ActionInvoked (spec de notificaciones, 1.2).
                            "ActivationToken" => {
                                if let Ok((id, token)) = body.deserialize::<(u32, String)>() {
                                    if let Some(entry) = book.live.get_mut(&id) {
                                        entry.1 = Some(token);
                                    }
                                }
                            }
                            "ActionInvoked" => {
                                if let Ok((id, _action)) = body.deserialize::<(u32, String)>() {
                                    if let Some((toast, token)) = book.remove(id) {
                                        // Queda anotado para cerrarlo después de usar el token.
                                        book.clicked.push(id);
                                        drop(book);
                                        on_click(toast, token);
                                    }
                                }
                            }
                            "NotificationClosed" => {
                                if let Ok((id, _reason)) = body.deserialize::<(u32, u32)>() {
                                    book.remove(id);
                                    book.clicked.retain(|c| *c != id);
                                }
                            }
                            _ => {}
                        }
                    }
                    eprintln!("Se cortó la escucha de los avisos: los clics dejan de responder.");
                })
                .map_err(|e| zbus::Error::Failure(e.to_string()))?;
            Ok(Self {
                proxy,
                markup,
                book,
            })
        }

        pub fn show(&self, toast: Toast) -> zbus::Result<()> {
            let group = group_key(&toast);
            let mut book = self.book.lock().unwrap();
            let replaces = book.by_group.get(&group).copied().unwrap_or(0);
            let body = toast.body.clone().unwrap_or_default();
            let body = if self.markup {
                escape_markup(&body)
            } else {
                body
            };
            let hints = hints();
            let id: u32 = self.proxy.call(
                "Notify",
                &(
                    "control-plane",
                    replaces,
                    "",
                    toast.title.as_str(),
                    body.as_str(),
                    // "default": el clic en el aviso.
                    vec!["default", "Abrir"],
                    hints,
                    -1i32,
                ),
            )?;
            if replaces != 0 && replaces != id {
                book.live.remove(&replaces);
            }
            book.by_group.insert(group, id);
            book.live.insert(id, (toast, None));
            Ok(())
        }

        /// Cierra todos los avisos vivos (y los tocados) con `CloseNotification`.
        pub fn dismiss_all(&self) {
            let ids = self.book.lock().unwrap().take_all();
            for id in ids {
                // Si ya no existe, el demonio lo ignora o contesta un error: da igual.
                let _: zbus::Result<()> = self.proxy.call("CloseNotification", &(id,));
            }
        }
    }

    /// Hints del aviso. `suppress-sound`: el sonido lo pone la web (también con la ventana
    /// escondida); sin esto, KDE, dunst y otros sonarían una segunda vez. `desktop-entry`: para
    /// que el sistema asocie el aviso con la app instalada (nombre e ícono).
    pub(super) fn hints() -> HashMap<&'static str, Value<'static>> {
        HashMap::from([
            ("suppress-sound", Value::Bool(true)),
            ("desktop-entry", Value::from(super::desktop_id())),
        ])
    }

    impl Book {
        /// Vacía el registro y devuelve los ids para cerrar.
        pub(super) fn take_all(&mut self) -> Vec<u32> {
            let mut ids: Vec<u32> = self.live.drain().map(|(id, _)| id).collect();
            ids.append(&mut self.clicked);
            self.by_group.clear();
            ids.sort_unstable();
            ids.dedup();
            ids
        }

        fn remove(&mut self, id: u32) -> Option<(Toast, Option<String>)> {
            self.by_group.retain(|_, v| *v != id);
            self.live.remove(&id)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn take_all_returns_live_and_clicked_once_and_empties_the_book() {
            let mut b = Book::default();
            b.live.insert(7, (Toast::default(), None));
            b.live.insert(3, (Toast::default(), Some("tok".into())));
            b.by_group.insert("session:s".into(), 7);
            b.clicked = vec![9, 3];
            assert_eq!(b.take_all(), vec![3, 7, 9]);
            assert!(b.live.is_empty() && b.by_group.is_empty() && b.clicked.is_empty());
            assert!(b.take_all().is_empty());
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use mac_notification_sys::{
        get_bundle_identifier, get_bundle_identifier_or_default, set_application, Notification,
        NotificationResponse,
    };

    use crate::desktop_ws::Toast;

    /// Cada aviso que espera el clic ocupa un hilo hasta que se toca o se descarta.
    const MAX_WAITING: usize = 8;

    pub struct Mac {
        on_click: Arc<dyn Fn(Toast) + Send + Sync>,
        waiting: Arc<AtomicUsize>,
    }

    impl Mac {
        pub fn new(app_name: &str, on_click: impl Fn(Toast) + Send + Sync + 'static) -> Self {
            // La app instalada firma los avisos con su nombre e ícono; sin instalar (dev), el
            // valor por defecto de la librería.
            let bundle = get_bundle_identifier(app_name)
                .unwrap_or_else(|| get_bundle_identifier_or_default("use_default"));
            let _ = set_application(&bundle);
            Self {
                on_click: Arc::new(on_click),
                waiting: Arc::new(AtomicUsize::new(0)),
            }
        }

        pub fn show(&self, toast: Toast) {
            let wait = self.waiting.fetch_add(1, Ordering::SeqCst) < MAX_WAITING;
            let on_click = self.on_click.clone();
            let waiting = self.waiting.clone();
            std::thread::spawn(move || {
                let body = toast.body.clone().unwrap_or_default();
                let res = Notification::new()
                    .title(&toast.title)
                    .message(&body)
                    .wait_for_click(wait)
                    .send();
                waiting.fetch_sub(1, Ordering::SeqCst);
                if let Ok(NotificationResponse::Click) = res {
                    on_click(toast);
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toast() -> Toast {
        Toast {
            level: "info".into(),
            title: "Título".into(),
            ..Toast::default()
        }
    }

    #[test]
    fn notify_only_when_the_page_is_not_in_front() {
        assert!(should_notify(true, false, false));
        assert!(should_notify(true, true, false));
        assert!(should_notify(true, false, true));
        assert!(!should_notify(true, true, true));
        assert!(!should_notify(false, false, false));
    }

    #[test]
    fn groups_by_session_then_project() {
        let mut t = toast();
        assert_eq!(group_key(&t), "general");
        t.project_id = Some("p".into());
        assert_eq!(group_key(&t), "project:p");
        t.session_id = Some("s".into());
        assert_eq!(group_key(&t), "session:s");
    }

    #[test]
    fn open_script_is_json_with_only_the_target() {
        let mut t = toast();
        assert_eq!(open_script(&t), None);
        t.project_id = Some("p1".into());
        t.session_id = Some("s1".into());
        t.open = Some("compaction".into());
        t.body = Some("no va".into());
        assert_eq!(
            open_script(&t).unwrap(),
            r#"window.__cpDesktop?.open({"projectId":"p1","sessionId":"s1","open":"compaction"})"#
        );
    }

    #[test]
    fn open_script_cannot_break_out_of_the_string() {
        let mut t = toast();
        t.session_id = Some("\"});alert(1);//\u{2028}</script>\\".into());
        let js = open_script(&t).unwrap();
        let arg = js
            .strip_prefix("window.__cpDesktop?.open(")
            .and_then(|s| s.strip_suffix(')'))
            .unwrap();
        let back: serde_json::Value = serde_json::from_str(arg).unwrap();
        assert_eq!(back["sessionId"], t.session_id.clone().unwrap());
        assert!(!js.contains('\u{2028}'));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_notifications_do_not_play_a_sound() {
        use zbus::zvariant::Value;
        let h = linux::hints();
        assert_eq!(h.get("suppress-sound"), Some(&Value::Bool(true)));
        assert_eq!(h.get("desktop-entry"), Some(&Value::from(desktop_id())));
    }

    #[test]
    fn markup_is_escaped() {
        assert_eq!(escape_markup("a <b> & c"), "a &lt;b&gt; &amp; c");
    }
}
