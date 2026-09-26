//! El número en el ícono del dock (Linux): lo mismo que dice la bandeja.
//!
//! Se publica con la señal `com.canonical.Unity.LauncherEntry.Update`, la que escuchan el dock de
//! Ubuntu (dash-to-dock) y KDE. Con un número visible, el dock lo muestra en lugar de contar los
//! avisos de la app; con `count-visible` en false vuelve a contar los avisos que siguen en la lista
//! (por eso la app los cierra cuando ya se vieron). El dock asocia la señal por el `.desktop` y la
//! olvida si se cae la conexión que la mandó: la conexión vive lo que vive la app (y si falla,
//! se reabre y se vuelve a publicar).

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

/// Estado de Tauri. Un hilo propio tiene la conexión al bus y publica: quien llama a
/// [`Launcher::set`] nunca espera al bus (lo llama la tarea del WS de escritorio).
pub struct Launcher {
    #[cfg(target_os = "linux")]
    tx: std::sync::mpsc::Sender<Option<u32>>,
}

impl Launcher {
    pub fn start() -> Self {
        #[cfg(target_os = "linux")]
        {
            let (tx, rx) = std::sync::mpsc::channel();
            let _ = std::thread::Builder::new()
                .name("contador-dock".into())
                .spawn(move || linux::run(rx));
            Self { tx }
        }
        #[cfg(not(target_os = "linux"))]
        Self {}
    }

    /// Pide mostrar `count` (o nada). El hilo publica solo si cambió.
    pub fn set(&self, count: Option<u32>) {
        #[cfg(target_os = "linux")]
        let _ = self.tx.send(count);
        #[cfg(not(target_os = "linux"))]
        let _ = count;
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::time::Duration;

    use zbus::blocking::Connection;
    use zbus::zvariant::Value;

    const PATH: &str = "/app/control_plane/LauncherEntry";
    const RETRY: Duration = Duration::from_secs(5);

    fn publish(conn: &Connection, count: Option<u32>) -> zbus::Result<()> {
        let props: HashMap<&str, Value> = HashMap::from([
            ("count", Value::I64(i64::from(count.unwrap_or(0)))),
            ("count-visible", Value::Bool(count.is_some())),
        ]);
        let uri = super::app_uri(crate::notify::desktop_id());
        conn.emit_signal(
            None::<()>,
            PATH,
            "com.canonical.Unity.LauncherEntry",
            "Update",
            &(uri.as_str(), props),
        )
    }

    /// Publica lo último pedido. Si el bus falla, reintenta cada tanto con el último valor (sin
    /// esperar a que el resumen cambie).
    pub(super) fn run(rx: Receiver<Option<u32>>) {
        let mut conn: Option<Connection> = None;
        let mut wanted: Option<Option<u32>> = None;
        let mut shown: Option<Option<u32>> = None;
        loop {
            let pending = wanted.is_some() && wanted != shown;
            let msg = if pending {
                rx.recv_timeout(RETRY)
            } else {
                rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            };
            match msg {
                Ok(c) => wanted = Some(c),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            // Lo último que haya en la cola, sin publicar los intermedios.
            while let Ok(c) = rx.try_recv() {
                wanted = Some(c);
            }
            let Some(want) = wanted else { continue };
            if shown == Some(want) {
                continue;
            }
            if conn.is_none() {
                conn = Connection::session()
                    .map_err(|e| eprintln!("Sin contador en el dock: {e}"))
                    .ok();
            }
            let Some(c) = &conn else { continue };
            match publish(c, want) {
                Ok(()) => shown = Some(want),
                Err(e) => {
                    eprintln!("No pude actualizar el contador del dock: {e}");
                    conn = None;
                }
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
