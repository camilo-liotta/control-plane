//! Cliente del WS de escritorio del server (`ws://127.0.0.1:<puerto>/ws?client=desktop`).
//!
//! El server manda dos tipos de mensaje: `desktop_summary` (al conectar y después de cada cambio)
//! y `toast`. Cualquier otro se ignora. El server rechaza otro `Host` y cualquier `Origin` ajeno:
//! mandamos `Host: 127.0.0.1:<puerto>` y ningún `Origin`.
//!
//! Corre en el runtime async de Tauri. Se reconecta solo, con espera creciente, y
//! [`DesktopWs::reconnect`] lo lleva a otro puerto (o lo apaga) al instante: lo usa el sidecar
//! cuando lanza o adopta un server.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, HOST, ORIGIN};
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub needs: u32,
    #[serde(default)]
    pub working: u32,
}

/// Lo mismo que la bandeja de entrada de la web: sesiones que te necesitan más propuestas listas,
/// y cuántas están trabajando.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Summary {
    #[serde(default)]
    pub needs: u32,
    #[serde(default)]
    pub working: u32,
    /// Sesiones con el proceso vivo: las que corta detener el server (para el diálogo de salida).
    #[serde(default)]
    pub running: u32,
    #[serde(default)]
    pub projects: Vec<ProjectSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    /// `info`, `success`, `warn` o `error` (se acepta cualquier texto).
    #[serde(default)]
    pub level: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Qué abrir al tocarlo (`compaction`); por defecto, la sesión.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerMessage {
    Summary(Summary),
    Toast(Toast),
}

/// Lee un mensaje del server. Lo desconocido o mal formado devuelve `None`, nunca un error.
pub fn parse(text: &str) -> Option<ServerMessage> {
    let Value::Object(mut map) = serde_json::from_str::<Value>(text).ok()? else {
        return None;
    };
    match map.get("type")?.as_str()? {
        "desktop_summary" => serde_json::from_value(map.remove("summary")?)
            .ok()
            .map(ServerMessage::Summary),
        "toast" => serde_json::from_value(Value::Object(map))
            .ok()
            .map(ServerMessage::Toast),
        _ => None,
    }
}

/// El pedido del handshake: el `Host` que acepta el server y sin `Origin`.
pub fn request(port: u16) -> Request {
    let mut req = format!("ws://127.0.0.1:{port}/ws?client=desktop")
        .into_client_request()
        .expect("URL válida");
    let host = HeaderValue::from_str(&format!("127.0.0.1:{port}")).expect("host válido");
    req.headers_mut().insert(HOST, host);
    req.headers_mut().remove(ORIGIN);
    req
}

/// Lo que se sabe del server en este momento.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub connected: bool,
    /// El último resumen; `None` sin conexión.
    pub summary: Option<Summary>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsEvent {
    /// Cambió la conexión o llegó un resumen: mirar [`DesktopWs::snapshot`].
    Changed(Snapshot),
    Toast(Toast),
}

/// Espera entre intentos: crece al doble hasta un tope y vuelve al mínimo con un mensaje válido
/// (no solo con el handshake: un server que acepta y corta no genera un loop apretado).
#[derive(Debug)]
pub struct Backoff(Duration);

impl Default for Backoff {
    fn default() -> Self {
        Self(BACKOFF_MIN)
    }
}

impl Backoff {
    pub fn next_delay(&mut self) -> Duration {
        let d = self.0;
        self.0 = (self.0 * 2).min(BACKOFF_MAX);
        d
    }
    pub fn reset(&mut self) {
        self.0 = BACKOFF_MIN;
    }
}

type Handler = Arc<dyn Fn(WsEvent) + Send + Sync>;

/// Estado de Tauri (`app.state::<DesktopWs>()`).
pub struct DesktopWs {
    port: watch::Sender<Option<u16>>,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl DesktopWs {
    /// Arranca el cliente. `port = None`: queda sin conexión hasta que llegue un puerto.
    pub fn start(port: Option<u16>, on_event: impl Fn(WsEvent) + Send + Sync + 'static) -> Self {
        let (tx, rx) = watch::channel(port);
        let snapshot = Arc::new(Mutex::new(Snapshot::default()));
        let shared = Shared {
            snapshot: snapshot.clone(),
            on_event: Arc::new(on_event),
        };
        tauri::async_runtime::spawn(run(rx, shared));
        Self { port: tx, snapshot }
    }

    /// Corta la conexión actual y se conecta ya a `port` (aunque sea el mismo), sin esperar el
    /// backoff. `None` la deja sin conexión. Para el sidecar, cuando lanza o adopta un server.
    pub fn reconnect(&self, port: Option<u16>) {
        self.port.send_replace(port);
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }
}

#[derive(Clone)]
struct Shared {
    snapshot: Arc<Mutex<Snapshot>>,
    on_event: Handler,
}

impl Shared {
    /// Aplica un cambio y avisa solo si el estado cambió de verdad (el server repite valores).
    fn update(&self, f: impl FnOnce(&mut Snapshot)) {
        let changed = {
            let mut s = self.snapshot.lock().unwrap();
            let before = s.clone();
            f(&mut s);
            (*s != before).then(|| s.clone())
        };
        if let Some(s) = changed {
            (self.on_event)(WsEvent::Changed(s));
        }
    }

    fn disconnected(&self) {
        self.update(|s| *s = Snapshot::default());
    }
}

async fn run(mut port_rx: watch::Receiver<Option<u16>>, shared: Shared) {
    let mut backoff = Backoff::default();
    loop {
        let port = *port_rx.borrow_and_update();
        if let Some(port) = port {
            tokio::select! {
                () = session(port, &shared, &mut backoff) => {}
                changed = port_rx.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    shared.disconnected();
                    backoff.reset();
                    continue;
                }
            }
        }
        shared.disconnected();
        let wait = backoff.next_delay();
        tokio::select! {
            () = tokio::time::sleep(wait), if port.is_some() => {}
            changed = port_rx.changed() => {
                if changed.is_err() {
                    return;
                }
                backoff.reset();
            }
        }
    }
}

/// Una conexión, hasta que se corte.
async fn session(port: u16, shared: &Shared, backoff: &mut Backoff) {
    let connect = tokio_tungstenite::connect_async(request(port));
    let Ok(Ok((mut ws, _))) = tokio::time::timeout(CONNECT_TIMEOUT, connect).await else {
        return;
    };
    shared.update(|s| s.connected = true);
    while let Some(Ok(msg)) = ws.next().await {
        let Message::Text(text) = msg else { continue };
        match parse(text.as_str()) {
            Some(ServerMessage::Summary(summary)) => {
                backoff.reset();
                shared.update(|s| s.summary = Some(summary));
            }
            Some(ServerMessage::Toast(toast)) => {
                backoff.reset();
                (shared.on_event)(WsEvent::Toast(toast));
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::handshake::server::{Request as SReq, Response};

    #[test]
    fn parses_summary() {
        let m = parse(
            r#"{"type":"desktop_summary","summary":{"needs":3,"working":2,"running":4,"projects":[{"id":"a","name":"Alfa","needs":3,"working":0,"extra":true}]}}"#,
        );
        assert_eq!(
            m,
            Some(ServerMessage::Summary(Summary {
                needs: 3,
                working: 2,
                running: 4,
                projects: vec![ProjectSummary {
                    id: "a".into(),
                    name: "Alfa".into(),
                    needs: 3,
                    working: 0
                }],
            }))
        );
    }

    #[test]
    fn parses_toast_with_optional_fields() {
        let Some(ServerMessage::Toast(t)) = parse(
            r#"{"type":"toast","level":"warn","title":"Hola","body":"b","projectId":"p","sessionId":"s","open":"compaction","nuevo":1}"#,
        ) else {
            panic!("tenía que ser un toast");
        };
        assert_eq!(t.level, "warn");
        assert_eq!(t.project_id.as_deref(), Some("p"));
        assert_eq!(t.session_id.as_deref(), Some("s"));
        assert_eq!(t.open.as_deref(), Some("compaction"));
        let Some(ServerMessage::Toast(t)) = parse(r#"{"type":"toast","title":"Solo título"}"#)
        else {
            panic!("tenía que ser un toast");
        };
        assert_eq!(t.body, None);
    }

    #[test]
    fn unknown_or_broken_messages_are_ignored() {
        for s in [
            "",
            "no json",
            "[]",
            "null",
            r#"{"type":"hello"}"#,
            r#"{"type":"desktop"}"#,
            r#"{"type":"desktop_summary"}"#,
            r#"{"type":"desktop_summary","summary":{"needs":"tres"}}"#,
            r#"{"type":"toast"}"#,
            r#"{"type":"toast","title":5}"#,
            r#"{"type":3}"#,
        ] {
            assert_eq!(parse(s), None, "{s}");
        }
        // Un resumen sin campos es un resumen vacío, no un error.
        assert_eq!(
            parse(r#"{"type":"desktop_summary","summary":{}}"#),
            Some(ServerMessage::Summary(Summary::default()))
        );
    }

    #[test]
    fn handshake_sends_local_host_and_no_origin() {
        let req = request(4730);
        assert_eq!(req.headers().get(HOST).unwrap(), "127.0.0.1:4730");
        assert!(req.headers().get(ORIGIN).is_none());
        assert_eq!(
            req.uri().to_string(),
            "ws://127.0.0.1:4730/ws?client=desktop"
        );
    }

    #[test]
    fn backoff_grows_to_a_cap_and_resets() {
        let mut b = Backoff::default();
        let delays: Vec<_> = (0..7).map(|_| b.next_delay().as_millis()).collect();
        assert_eq!(delays, [500, 1000, 2000, 4000, 8000, 10000, 10000]);
        b.reset();
        assert_eq!(b.next_delay(), BACKOFF_MIN);
    }

    /// Un server de mentira que revisa el handshake como el de verdad, manda un resumen repetido,
    /// algo desconocido y un toast, y corta.
    #[tokio::test(flavor = "multi_thread")]
    #[allow(clippy::result_large_err)] // la firma del callback la fija tungstenite
    async fn talks_to_a_server_and_reconnects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel::<(String, bool)>();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let seen = seen_tx.clone();
                let mut ws =
                    tokio_tungstenite::accept_hdr_async(tcp, |req: &SReq, res: Response| {
                        let host = req
                            .headers()
                            .get(HOST)
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_string();
                        let _ = seen.send((host, req.headers().contains_key(ORIGIN)));
                        Ok(res)
                    })
                    .await
                    .unwrap();
                let summary =
                    r#"{"type":"desktop_summary","summary":{"needs":1,"working":0,"projects":[]}}"#;
                for text in [
                    summary,
                    summary,
                    r#"{"type":"otro"}"#,
                    r#"{"type":"toast","level":"info","title":"Prueba"}"#,
                ] {
                    ws.send(Message::text(text)).await.unwrap();
                }
                let _ = ws.close(None).await;
            }
        });

        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let client = DesktopWs::start(Some(port), move |e| {
            let _ = ev_tx.send(e);
        });
        let (host, origin) = seen_rx.recv().await.unwrap();
        assert_eq!(host, format!("127.0.0.1:{port}"));
        assert!(!origin);

        let mut events = Vec::new();
        for _ in 0..4 {
            events.push(
                tokio::time::timeout(Duration::from_secs(5), ev_rx.recv())
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        let one = Summary {
            needs: 1,
            ..Summary::default()
        };
        assert_eq!(
            events,
            [
                WsEvent::Changed(Snapshot {
                    connected: true,
                    summary: None
                }),
                // El resumen repetido no genera otro evento.
                WsEvent::Changed(Snapshot {
                    connected: true,
                    summary: Some(one.clone())
                }),
                WsEvent::Toast(Toast {
                    level: "info".into(),
                    title: "Prueba".into(),
                    ..Toast::default()
                }),
                WsEvent::Changed(Snapshot::default()),
            ]
        );

        // Se reconecta solo después del corte.
        assert!(tokio::time::timeout(Duration::from_secs(5), seen_rx.recv())
            .await
            .unwrap()
            .is_some());

        // Sin puerto queda sin conexión.
        client.reconnect(None);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(client.snapshot(), Snapshot::default());
    }
}
