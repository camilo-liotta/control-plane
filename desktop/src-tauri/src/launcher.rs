//! El número en el ícono del dock (Linux): lo mismo que dice la bandeja.
//!
//! Se publica con la señal `com.canonical.Unity.LauncherEntry.Update`, la que escuchan el dock de
//! Ubuntu (dash-to-dock) y KDE. Con un número visible, el dock lo muestra en lugar de contar los
//! avisos de la app; con `count-visible` en false vuelve a contar los avisos que siguen en la lista
//! (por eso la app los cierra cuando ya se vieron). El dock asocia la señal por el `.desktop` y la
//! olvida si se cae la conexión que la mandó: la conexión vive lo que vive la app.

use std::sync::{Arc, Mutex, OnceLock};

use crate::desktop_ws::Snapshot;

/// Qué número mostrar: lo que te necesita, solo con conexión y si es más que cero. Sin conexión
/// no queda un número viejo.
pub fn badge(snap: &Snapshot) -> Option<u32> {
    snap.summary
        .as_ref()
        .filter(|_| snap.connected)
        .map(|s| s.needs)
        .filter(|n| *n > 0)
}

/// `application://<id>.desktop`, como la pide la spec de LauncherEntry.
pub fn app_uri(desktop_id: &str) -> String {
    format!("application://{desktop_id}.desktop")
}

/// Estado de Tauri. Se conecta al bus en otro hilo; hasta entonces las actualizaciones se guardan
/// y la última se publica apenas hay conexión.
#[derive(Clone, Default)]
pub struct Launcher {
    #[cfg(target_os = "linux")]
    conn: Arc<OnceLock<zbus::blocking::Connection>>,
    state: Arc<Mutex<Pending>>,
}

/// Lo último pedido y lo último publicado (`None` = todavía nada; `Some(None)` = sin número).
#[derive(Default)]
struct Pending {
    wanted: Option<Option<u32>>,
    shown: Option<Option<u32>>,
}

#[cfg(target_os = "linux")]
const PATH: &str = "/app/control_plane/LauncherEntry";

impl Launcher {
    pub fn start() -> Self {
        let this = Self::default();
        #[cfg(target_os = "linux")]
        {
            let me = this.clone();
            std::thread::spawn(move || match zbus::blocking::Connection::session() {
                Ok(c) => {
                    let _ = me.conn.set(c);
                    me.flush();
                }
                Err(e) => eprintln!("Sin contador en el dock: {e}"),
            });
        }
        this
    }

    /// Pide mostrar `count` (o nada). Solo se publica si cambió.
    pub fn set(&self, count: Option<u32>) {
        self.state.lock().unwrap().wanted = Some(count);
        self.flush();
    }

    fn flush(&self) {
        #[cfg(target_os = "linux")]
        {
            let Some(conn) = self.conn.get() else { return };
            let mut st = self.state.lock().unwrap();
            let Some(want) = st.wanted else { return };
            if st.shown == Some(want) {
                return;
            }
            use std::collections::HashMap;
            use zbus::zvariant::Value;
            let props: HashMap<&str, Value> = HashMap::from([
                ("count", Value::I64(i64::from(want.unwrap_or(0)))),
                ("count-visible", Value::Bool(want.is_some())),
            ]);
            let uri = app_uri(crate::notify::desktop_id());
            match conn.emit_signal(
                None::<()>,
                PATH,
                "com.canonical.Unity.LauncherEntry",
                "Update",
                &(uri.as_str(), props),
            ) {
                Ok(()) => st.shown = Some(want),
                Err(e) => eprintln!("No pude actualizar el contador del dock: {e}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_ws::Summary;

    fn snap(connected: bool, needs: u32) -> Snapshot {
        Snapshot {
            connected,
            summary: Some(Summary {
                needs,
                ..Summary::default()
            }),
        }
    }

    #[test]
    fn badge_is_needs_only_when_connected_and_positive() {
        assert_eq!(badge(&snap(true, 3)), Some(3));
        assert_eq!(badge(&snap(true, 0)), None);
        assert_eq!(badge(&snap(false, 3)), None);
        assert_eq!(badge(&Snapshot::default()), None);
    }

    #[test]
    fn uri_uses_the_desktop_file() {
        assert_eq!(
            app_uri("control-plane"),
            "application://control-plane.desktop"
        );
    }
}
