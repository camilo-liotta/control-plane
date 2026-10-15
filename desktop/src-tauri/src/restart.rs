//! Reiniciar el server retomando las sesiones (para actualizar, o si la app adoptó uno más viejo
//! que ella). El server arma el "guardar para retomar" con `POST /api/restart/prepare` y, si en
//! 120 s le llega el apagado ordenado de siempre (SIGTERM), escribe qué sesiones estaban activas;
//! el server nuevo las retoma al arrancar. Un server de antes de esto no conoce las rutas (404):
//! se reinicia igual, sin retomar.

use std::time::Duration;

use serde::Deserialize;

use crate::health::{request, Get};

const TIMEOUT: Duration = Duration::from_secs(4);

/// Lo que responden `preview` y `prepare` (lo que hace falta acá).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub version: String,
    #[serde(default)]
    pub working: u32,
    #[serde(default)]
    pub needs_input: u32,
    #[serde(default)]
    pub sessions: Vec<PreviewSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PreviewSession {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Ok(Preview),
    /// Un server de antes de "retomar": no conoce la ruta.
    Unsupported,
    Failed(String),
}

pub fn parse_reply(status: u16, body: &[u8]) -> Reply {
    match status {
        200 => match serde_json::from_slice::<Preview>(body) {
            Ok(p) => Reply::Ok(p),
            Err(e) => Reply::Failed(format!("respuesta inesperada: {e}")),
        },
        404 => Reply::Unsupported,
        s => Reply::Failed(format!("el server respondió {s}")),
    }
}

fn call(port: u16, method: &str, path: &str, body: Option<&str>) -> Reply {
    match request(port, method, path, body, TIMEOUT) {
        Get::Ok(r) => parse_reply(r.status, &r.body),
        Get::Refused => Reply::Failed("no hay server en el puerto".into()),
        Get::Timeout => Reply::Failed("el server no respondió a tiempo".into()),
        Get::Garbled => Reply::Failed("respuesta que no es HTTP".into()),
    }
}

/// Las sesiones con proceso vivo, sin tocar nada.
pub fn preview(port: u16) -> Reply {
    call(port, "GET", "/api/restart/preview", None)
}

/// Arma el "guardar para retomar": el SIGTERM que sigue lo usa.
pub fn prepare(port: u16, reason: &str) -> Reply {
    let body = serde_json::json!({ "reason": reason }).to_string();
    call(port, "POST", "/api/restart/prepare", Some(&body))
}

/// Desarma el pedido (si al final no se reinicia).
pub fn cancel(port: u16) {
    let _ = call(port, "POST", "/api/restart/cancel", Some("{}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies() {
        let body = br#"{"version":"0.3.2","sessions":[{"id":"s1","name":"API","projectId":"p","projectName":"P","status":"working"}],"working":1,"needsInput":0,"armedUntil":1}"#;
        let Reply::Ok(p) = parse_reply(200, body) else {
            panic!("tiene que entenderla")
        };
        assert_eq!(
            (p.version.as_str(), p.working, p.needs_input),
            ("0.3.2", 1, 0)
        );
        assert_eq!(p.sessions[0].name, "API");
        assert_eq!(
            parse_reply(404, br#"{"message":"Route GET:/api/restart/preview not found","error":"Not Found","statusCode":404}"#),
            Reply::Unsupported
        );
        assert!(matches!(parse_reply(403, b"{}"), Reply::Failed(_)));
        assert!(matches!(parse_reply(200, b"no"), Reply::Failed(_)));
    }
}
