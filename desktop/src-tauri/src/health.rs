//! Reconocer qué hay escuchando en el puerto: `GET /api/health` con el Host que acepta el server
//! y sin Origin, por HTTP a mano (una conexión, respuesta chica, sin dependencias).

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use serde::Deserialize;

pub const TIMEOUT: Duration = Duration::from_millis(1500);
/// Tope de lo que se lee de una respuesta (el health son ~150 bytes).
const MAX_BYTES: usize = 64 * 1024;

/// Lo que responde `/api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub app: String,
    pub version: String,
    pub pid: u32,
    pub port: u16,
    pub started_at: u64,
    pub launch_id: Option<String>,
}

/// Qué hay en el puerto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// Nadie escucha: se puede lanzar el server.
    Refused,
    ControlPlane(Health),
    /// Un control-plane anterior al health (responde el dashboard pero no `/api/health`).
    OldControlPlane,
    /// Otro programa (u otra cosa que no se entiende).
    Other(String),
    /// Aceptó la conexión y no respondió a tiempo.
    Timeout,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Parsea una respuesta HTTP/1.x completa (sin keep-alive). `None` si no es HTTP.
pub fn parse_response(raw: &[u8]) -> Option<Response> {
    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..head_end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut status_line = lines.next()?.split(' ');
    if !status_line.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let status = status_line.next()?.parse().ok()?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = &raw[head_end + 4..];
    let body = if chunked {
        dechunk(body)?
    } else {
        body.to_vec()
    };
    Some(Response { status, body })
}

fn dechunk(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|w| w == b"\r\n")?;
        let size_str = std::str::from_utf8(&data[..line_end]).ok()?;
        let size = usize::from_str_radix(size_str.split(';').next()?.trim(), 16).ok()?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(data.get(..size)?);
        data = data.get(size + 2..)?;
    }
}

/// Clasifica la respuesta del health. `root` es la de `GET /`, que solo se pide si el health no
/// dio JSON de control-plane (para reconocer un server viejo).
pub fn classify(health: &Response, root: Option<&Response>) -> Probe {
    if health.status == 200 {
        if let Ok(h) = serde_json::from_slice::<Health>(&health.body) {
            if h.app == "control-plane" {
                return Probe::ControlPlane(h);
            }
        }
    }
    let is_old = health.status == 404
        && root.is_some_and(|r| {
            r.status == 200
                && String::from_utf8_lossy(&r.body).contains("<title>control-plane</title>")
        });
    if is_old {
        return Probe::OldControlPlane;
    }
    Probe::Other(format!("respondió {} en /api/health", health.status))
}

enum Get {
    Refused,
    Timeout,
    Garbled,
    Ok(Response),
}

fn get(port: u16, path: &str, timeout: Duration) -> Get {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::TimedOut => return Get::Timeout,
        Err(_) => return Get::Refused,
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return Get::Garbled;
    }
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > MAX_BYTES {
                    break;
                }
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if raw.is_empty() {
                    return Get::Timeout;
                }
                break;
            }
            Err(_) => break,
        }
    }
    match parse_response(&raw) {
        Some(r) => Get::Ok(r),
        None => Get::Garbled,
    }
}

/// ¿Qué hay en `127.0.0.1:<port>`?
pub fn probe(port: u16) -> Probe {
    probe_with(port, TIMEOUT)
}

pub fn probe_with(port: u16, timeout: Duration) -> Probe {
    match get(port, "/api/health", timeout) {
        Get::Refused => Probe::Refused,
        Get::Timeout => Probe::Timeout,
        Get::Garbled => Probe::Other("no habla HTTP".into()),
        Get::Ok(r) => {
            let first = classify(&r, None);
            if !matches!(first, Probe::Other(_)) || r.status != 404 {
                return first;
            }
            let root = match get(port, "/", timeout) {
                Get::Ok(root) => Some(root),
                _ => None,
            };
            classify(&r, root.as_ref())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    const HEALTH: &str = r#"{"app":"control-plane","version":"0.1.0","pid":123,"port":4711,"startedAt":1790000000000,"launchId":"abc"}"#;

    fn resp(status: u16, body: &str) -> Response {
        Response {
            status,
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn parses_plain_and_chunked() {
        let raw = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{HEALTH}",
            HEALTH.len()
        );
        assert_eq!(parse_response(raw.as_bytes()).unwrap(), resp(200, HEALTH));
        let raw = b"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw).unwrap(), resp(404, "hello world"));
        assert_eq!(parse_response(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(parse_response(b"garbage\r\n\r\nx"), None);
    }

    #[test]
    fn classify_control_plane() {
        let Probe::ControlPlane(h) = classify(&resp(200, HEALTH), None) else {
            panic!("tiene que reconocerlo");
        };
        assert_eq!(
            (h.pid, h.port, h.launch_id.as_deref()),
            (123, 4711, Some("abc"))
        );
        let no_launch = HEALTH.replace(r#","launchId":"abc""#, r#","launchId":null"#);
        assert!(
            matches!(classify(&resp(200, &no_launch), None), Probe::ControlPlane(h) if h.launch_id.is_none())
        );
    }

    #[test]
    fn classify_old_other_and_forbidden() {
        let old_root = resp(
            200,
            "<html><head><title>control-plane</title></head></html>",
        );
        let not_found = resp(404, r#"{"error":"no encontrado"}"#);
        assert_eq!(
            classify(&not_found, Some(&old_root)),
            Probe::OldControlPlane
        );
        assert!(matches!(
            classify(
                &not_found,
                Some(&resp(200, "<title>Directory listing</title>"))
            ),
            Probe::Other(_)
        ));
        assert!(matches!(classify(&not_found, None), Probe::Other(_)));
        // 403 (otro Host permitido), JSON de otra app, 200 que no es JSON.
        assert!(matches!(
            classify(
                &resp(403, r#"{"error":"host no permitido"}"#),
                Some(&old_root)
            ),
            Probe::Other(_)
        ));
        assert!(matches!(
            classify(
                &resp(
                    200,
                    r#"{"app":"otra","version":"1","pid":1,"port":1,"startedAt":1}"#
                ),
                None
            ),
            Probe::Other(_)
        ));
        assert!(matches!(
            classify(&resp(200, "hola"), None),
            Probe::Other(_)
        ));
    }

    fn serve_once(reply: &'static [u8]) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut s in l.incoming().flatten().take(2) {
                let mut buf = [0u8; 1024];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                assert!(req.contains(&format!("Host: 127.0.0.1:{port}")), "{req}");
                assert!(!req.to_ascii_lowercase().contains("origin:"), "{req}");
                let _ = s.write_all(reply);
            }
        });
        port
    }

    #[test]
    fn probe_real_sockets() {
        let body = HEALTH;
        let reply: &'static [u8] = Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            )
            .into_bytes()
            .into_boxed_slice(),
        );
        assert!(matches!(probe(serve_once(reply)), Probe::ControlPlane(_)));

        // Un puerto sin nadie: conexión rechazada.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(probe(port), Probe::Refused);
    }

    #[test]
    fn probe_silent_server_times_out() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            let _held: Vec<_> = l.incoming().take(1).collect();
            thread::sleep(Duration::from_secs(2));
        });
        assert_eq!(probe_with(port, Duration::from_millis(200)), Probe::Timeout);
    }
}
