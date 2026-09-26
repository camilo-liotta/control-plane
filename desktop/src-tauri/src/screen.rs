//! La pantalla local (`ui/index.html`): qué muestra en cada caso y cómo sus botones le hablan a
//! la app **sin IPC**.
//!
//! Los botones navegan a `tauri://localhost/__action/<acción>?t=<token>`. La guarda de
//! navegación de la ventana intercepta esa URL, cancela la navegación y ejecuta la acción. El
//! token es aleatorio por corrida y solo viaja en la URL de la pantalla local: el dashboard
//! (`http://127.0.0.1:<puerto>`) no lo conoce, así que no puede disparar nada. La app no
//! registra comandos ni da permisos (capabilities vacías): ninguna página tiene IPC.

use std::fmt::Write as _;
use std::io::Read;

use tauri::Url;

pub const ACTION_PREFIX: &str = "/__action/";

/// La base de las URLs de la app (la pantalla local).
pub fn local_base() -> Url {
    #[cfg(windows)]
    let base = "http://tauri.localhost/";
    #[cfg(not(windows))]
    let base = "tauri://localhost/";
    Url::parse(base).expect("URL válida")
}

/// 16 bytes aleatorios en hexadecimal (para el token y el launchId).
pub fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
    if ok.is_err() {
        // Sin /dev/urandom (no pasa en Linux ni macOS): algo único igual, aunque predecible.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes = (nanos ^ ((std::process::id() as u128) << 64)).to_le_bytes();
    }
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Retry,
    /// Lanzar el server (cuando uno ajeno se detuvo).
    Launch,
    PickNode,
    /// Abrir nodejs.org en el navegador.
    GetNode,
    /// Usar un server viejo sin health igual.
    OpenAnyway,
    Cancel,
    /// Cambiar el puerto (viene en `p`).
    SetPort,
    /// Usar el server que tiene tomada la carpeta de datos.
    UseThat,
    /// Seguir esperando a que arranque.
    Wait,
    ShowLog,
    /// Detener el server que tarda en arrancar.
    Stop,
}

impl Action {
    pub fn id(self) -> &'static str {
        match self {
            Self::Retry => "retry",
            Self::Launch => "launch",
            Self::PickNode => "pick-node",
            Self::GetNode => "get-node",
            Self::OpenAnyway => "open-anyway",
            Self::Cancel => "cancel",
            Self::SetPort => "set-port",
            Self::UseThat => "use-that",
            Self::Wait => "wait",
            Self::ShowLog => "log",
            Self::Stop => "stop",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        [
            Self::Retry,
            Self::Launch,
            Self::PickNode,
            Self::GetNode,
            Self::OpenAnyway,
            Self::Cancel,
            Self::SetPort,
            Self::UseThat,
            Self::Wait,
            Self::ShowLog,
            Self::Stop,
        ]
        .into_iter()
        .find(|a| a.id() == id)
    }
}

/// Una acción pedida desde la pantalla local.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub action: Action,
    pub port: Option<u16>,
}

/// ¿Es un pedido de acción válido? Tiene que venir de la app (`tauri://localhost`), con el
/// token de esta corrida.
pub fn parse_action(url: &Url, token: &str) -> Option<Request> {
    let base = local_base();
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port() != base.port()
    {
        return None;
    }
    let id = url.path().strip_prefix(ACTION_PREFIX)?;
    let mut t = None;
    let mut port = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "t" => t = Some(v.into_owned()),
            "p" => port = v.trim().parse::<u16>().ok().filter(|p| *p != 0),
            _ => {}
        }
    }
    if token.is_empty() || t.as_deref() != Some(token) {
        return None;
    }
    Some(Request {
        action: Action::from_id(id)?,
        port,
    })
}

/// Es una URL de acción (válida o no): nunca se navega a ella.
pub fn is_action_url(url: &Url) -> bool {
    let base = local_base();
    url.scheme() == base.scheme()
        && url.host_str() == base.host_str()
        && url.path().starts_with(ACTION_PREFIX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Loading,
    Warn,
    Error,
}

impl Tone {
    fn id(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// Lo que muestra la pantalla local.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    pub tone: Tone,
    pub title: String,
    pub message: String,
    pub detail: Option<String>,
    pub log: Vec<String>,
    pub actions: Vec<Action>,
    /// Un aviso que no bloquea (p. ej. no se pudo leer la shell de login).
    pub notice: Option<String>,
    /// Puerto sugerido para "Cambiar puerto".
    pub port: Option<u16>,
}

impl Screen {
    fn new(tone: Tone, title: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            tone,
            title: title.into(),
            message: message.into(),
            detail: None,
            log: Vec::new(),
            actions: Vec::new(),
            notice: None,
            port: None,
        }
    }

    fn detail(mut self, d: impl Into<String>) -> Self {
        self.detail = Some(d.into());
        self
    }

    fn log(mut self, log: Vec<String>) -> Self {
        self.log = log;
        self
    }

    fn actions(mut self, a: &[Action]) -> Self {
        self.actions = a.to_vec();
        self
    }

    fn port(mut self, p: u16) -> Self {
        self.port = Some(p);
        self
    }

    pub fn with_notice(mut self, notice: Option<String>) -> Self {
        self.notice = notice;
        self
    }

    /// La URL de la pantalla local con este estado.
    pub fn url(&self, token: &str) -> Url {
        let mut url = local_base().join("index.html").expect("URL válida");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("t", token)
                .append_pair("tone", self.tone.id())
                .append_pair("title", &self.title)
                .append_pair("message", &self.message);
            if let Some(d) = &self.detail {
                q.append_pair("detail", d);
            }
            if !self.log.is_empty() {
                q.append_pair("log", &self.log.join("\n"));
            }
            if !self.actions.is_empty() {
                let ids: Vec<&str> = self.actions.iter().map(|a| a.id()).collect();
                q.append_pair("actions", &ids.join(","));
            }
            if let Some(n) = &self.notice {
                q.append_pair("notice", n);
            }
            if let Some(p) = self.port {
                q.append_pair("port", &p.to_string());
            }
        }
        url
    }

    // ------------------------------------------------------------------ cada caso

    pub fn loading() -> Self {
        Self::new(
            Tone::Loading,
            "Abriendo control-plane…",
            "Preparando el entorno.",
        )
    }

    pub fn looking(port: u16) -> Self {
        Self::new(
            Tone::Loading,
            "Buscando el server…",
            format!("Me fijo si ya hay uno en el puerto {port}."),
        )
    }

    pub fn starting(port: u16) -> Self {
        Self::new(
            Tone::Loading,
            "Arrancando el server…",
            format!("Lo lanzo en el puerto {port}. Tarda unos segundos."),
        )
        .actions(&[Action::ShowLog])
    }

    pub fn slow(port: u16) -> Self {
        Self::new(
            Tone::Warn,
            "El server tarda más de lo normal",
            format!("Hace 30 segundos que lo lancé en el puerto {port} y todavía no responde."),
        )
        .actions(&[Action::Wait, Action::ShowLog, Action::Stop])
    }

    pub fn bad_port(err: &str) -> Self {
        Self::new(
            Tone::Error,
            "No puedo usar ese puerto",
            "Elegí otro y lo pruebo.",
        )
        .detail(err)
        .actions(&[Action::SetPort])
    }

    pub fn bad_home(err: &str) -> Self {
        Self::new(
            Tone::Error,
            "No puedo usar esa carpeta de datos",
            "La app de desarrollo nunca usa la carpeta de datos de todos los días.",
        )
        .detail(err)
    }

    pub fn no_node(err: &str) -> Self {
        Self::new(
            Tone::Error,
            "Falta Node 24",
            "El server de control-plane corre con Node 24 o más nuevo.",
        )
        .detail(err)
        .actions(&[Action::PickNode, Action::Retry, Action::GetNode])
    }

    pub fn no_claude(err: &str) -> Self {
        Self::new(
            Tone::Error,
            "No encontré Claude Code",
            "Sin el binario de Claude Code el server no arranca.",
        )
        .detail(err)
        .actions(&[Action::Retry])
    }

    pub fn other_program(port: u16, what: &str) -> Self {
        Self::new(
            Tone::Error,
            format!("El puerto {port} lo usa otro programa"),
            "No es un server de control-plane, así que no lo toco. Elegí otro puerto o cerrá ese programa y reintentá.",
        )
        .detail(what)
        .actions(&[Action::SetPort, Action::Retry])
        .port(port.saturating_add(1))
    }

    pub fn old_server(port: u16) -> Self {
        Self::new(
            Tone::Warn,
            "Hay un control-plane viejo en este puerto",
            format!(
                "El server del puerto {port} es de una versión anterior a la app. Reinicialo o actualizalo; si querés, lo abro igual."
            ),
        )
        .actions(&[Action::OpenAnyway, Action::Cancel])
    }

    pub fn old_server_waiting(port: u16) -> Self {
        Self::new(
            Tone::Warn,
            "Esperando un server actualizado",
            format!("Cuando reinicies el server del puerto {port}, tocá Reintentar."),
        )
        .actions(&[Action::Retry])
    }

    pub fn crashed(code: &str, log: Vec<String>) -> Self {
        Self::new(
            Tone::Error,
            "El server se cerró",
            format!("Terminó {code}. Esto es lo último que escribió:"),
        )
        .log(log)
        .actions(&[Action::Retry, Action::ShowLog])
    }

    pub fn crashed_claude(log: Vec<String>) -> Self {
        Self::new(
            Tone::Error,
            "El server no encontró Claude Code",
            "Instalalo o definí CLAUDE_BIN en tu shell y reintentá.",
        )
        .log(log)
        .actions(&[Action::Retry, Action::ShowLog])
    }

    pub fn locked(port: u16, pid: u32, log: Vec<String>) -> Self {
        Self::new(
            Tone::Warn,
            "Ya hay un server usando esta carpeta de datos",
            format!(
                "Está en el puerto {port} (pid {pid}). Podés usar ese, o detenerlo y reintentar."
            ),
        )
        .log(log)
        .actions(&[Action::UseThat, Action::Retry])
    }

    pub fn too_many_restarts(log: Vec<String>) -> Self {
        Self::new(
            Tone::Error,
            "El server se sigue cayendo",
            "Lo relancé 3 veces en 5 minutos y no aguanta. Mirá el log antes de reintentar.",
        )
        .log(log)
        .actions(&[Action::Retry, Action::ShowLog])
    }

    pub fn restarting() -> Self {
        Self::new(
            Tone::Loading,
            "El server se cerró: lo vuelvo a lanzar…",
            "Las sesiones que estaban trabajando se reanudan cuando les escribas.",
        )
        .actions(&[Action::ShowLog])
    }

    pub fn foreign_gone(port: u16) -> Self {
        Self::new(
            Tone::Warn,
            "El server se detuvo",
            format!(
                "El server del puerto {port} no lo había lanzado la app, así que no lo relanzo sola. ¿Lo lanzo yo?"
            ),
        )
        .actions(&[Action::Launch, Action::Retry])
    }

    pub fn not_responding(port: u16, pid: u32) -> Self {
        Self::new(
            Tone::Error,
            "El server no responde",
            format!(
                "El server del puerto {port} (pid {pid}) sigue vivo pero no contesta. No lo toco porque no puedo verificar que sea el de la app: si no se recupera, detenelo a mano y reintentá."
            ),
        )
        .actions(&[Action::Retry, Action::ShowLog])
    }

    pub fn stopping() -> Self {
        Self::new(
            Tone::Loading,
            "Deteniendo el server…",
            "Cierro las sesiones ordenadamente. Puede tardar unos segundos.",
        )
    }

    pub fn failed(what: &str) -> Self {
        Self::new(Tone::Error, "Algo salió mal", "No pude lanzar el server.")
            .detail(what)
            .actions(&[Action::Retry, Action::ShowLog])
    }
}

/// Aviso que no bloquea cuando la shell de login no respondió bien.
pub fn login_notice(shell: &str, err: &str) -> String {
    format!(
        "No pude leer el entorno de tu shell ({shell}: {err}). Uso las rutas de siempre; si falta algo, definilo en los ajustes."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn action_requests_need_the_token_and_the_local_origin() {
        let ok = parse_action(&url("tauri://localhost/__action/retry?t=abc"), "abc");
        assert_eq!(
            ok,
            Some(Request {
                action: Action::Retry,
                port: None
            })
        );
        let port = parse_action(
            &url("tauri://localhost/__action/set-port?t=abc&p=4713"),
            "abc",
        );
        assert_eq!(
            port,
            Some(Request {
                action: Action::SetPort,
                port: Some(4713)
            })
        );
        for bad in [
            "tauri://localhost/__action/retry",
            "tauri://localhost/__action/retry?t=otro",
            "tauri://localhost/__action/nada?t=abc",
            "http://127.0.0.1:4711/__action/retry?t=abc",
            "tauri://evil/__action/retry?t=abc",
            "tauri://localhost/index.html?t=abc",
        ] {
            assert_eq!(parse_action(&url(bad), "abc"), None, "{bad}");
        }
        // Sin token configurado, nada vale.
        assert_eq!(
            parse_action(&url("tauri://localhost/__action/retry?t="), ""),
            None
        );
        assert!(is_action_url(&url("tauri://localhost/__action/x")));
        assert!(!is_action_url(&url("http://127.0.0.1:4711/__action/x")));
    }

    #[test]
    fn bad_port_values_are_dropped() {
        for p in ["0", "70000", "x", ""] {
            let r = parse_action(
                &url(&format!("tauri://localhost/__action/set-port?t=a&p={p}")),
                "a",
            );
            assert_eq!(r.unwrap().port, None, "{p}");
        }
    }

    #[test]
    fn every_action_roundtrips() {
        for id in [
            "retry",
            "launch",
            "pick-node",
            "get-node",
            "open-anyway",
            "cancel",
            "set-port",
            "use-that",
            "wait",
            "log",
            "stop",
        ] {
            assert_eq!(Action::from_id(id).unwrap().id(), id);
        }
    }

    #[test]
    fn screen_url_carries_everything_escaped() {
        let s = Screen::crashed("con código 1", vec!["a & b".into(), "c".into()])
            .with_notice(Some("ojo".into()));
        let u = s.url("tok");
        assert_eq!(u.scheme(), local_base().scheme());
        assert_eq!(u.path(), "/index.html");
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["t"], "tok");
        assert_eq!(q["tone"], "error");
        assert_eq!(q["log"], "a & b\nc");
        assert_eq!(q["actions"], "retry,log");
        assert_eq!(q["notice"], "ojo");
    }

    #[test]
    fn random_hex_is_32_chars_and_changes() {
        let a = random_hex();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, random_hex());
    }
}
