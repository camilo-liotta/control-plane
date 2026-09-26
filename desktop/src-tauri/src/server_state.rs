//! De quién es el server: el archivo `server-<puerto>.json` que deja la app cuando lo lanza,
//! comparado con lo que responde `/api/health`. Y el `server.lock` del server, para ofrecer
//! "Usar ese" cuando la carpeta de datos ya está tomada.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::health::Health;

/// Lo que guarda la app de un server que lanzó ella.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateFile {
    /// El pid que responde el health (el de node, aunque lo lance un shim como el de Volta).
    pub pid: u32,
    /// El grupo del proceso que lanzó la app (setsid): para el SIGKILL final.
    #[serde(default)]
    pub pgid: Option<u32>,
    pub launch_id: String,
    pub port: u16,
    /// Milisegundos desde epoch, al lanzarlo.
    pub started_at: u64,
    pub log_path: PathBuf,
    /// Desde dónde escribió esta corrida en el log.
    pub log_offset: u64,
}

pub fn state_path(dir: &Path, port: u16) -> PathBuf {
    dir.join(format!("server-{port}.json"))
}

impl StateFile {
    /// Un archivo roto se trata como si no existiera.
    pub fn read(path: &Path) -> Option<Self> {
        serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
    }

    pub fn write(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(
            &tmp,
            serde_json::to_string_pretty(self).map_err(io::Error::other)?,
        )?;
        fs::rename(tmp, path)
    }

    pub fn remove(path: &Path) {
        let _ = fs::remove_file(path);
    }
}

/// Quién lanzó el server que responde en el puerto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// La app (en esta corrida o en una anterior que se cerró sin detenerlo).
    Own,
    /// Otro: `npm start`, otra app, otra sesión. No se le mandan señales nunca.
    Foreign,
}

/// Es propio solo si el health trae el mismo launchId **y** el mismo pid que guardó la app.
pub fn owner(state: Option<&StateFile>, health: &Health) -> Owner {
    match state {
        Some(s)
            if health.launch_id.as_deref() == Some(s.launch_id.as_str())
                && health.pid == s.pid
                && health.port == s.port =>
        {
            Owner::Own
        }
        _ => Owner::Foreign,
    }
}

/// Lo que la app sabe del server propio para poder mandarle una señal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub pid: u32,
    pub launch_id: String,
    /// Grupo del server (el pid del proceso que lanzó la app).
    pub pgid: u32,
}

/// Antes de cada señal: el health recién pedido tiene que ser el mismo server (mismo pid y
/// mismo launchId). Así un pid reusado o un server ajeno en el puerto nunca reciben nada.
/// `child_alive`: es hijo directo de la app y todavía no se lo cosechó (su pid no se puede
/// reusar mientras tanto), así que alcanza aunque el health no responda.
pub fn may_signal(expected: &Expected, fresh: Option<&Health>, child_alive: bool) -> bool {
    if child_alive {
        return true;
    }
    fresh.is_some_and(|h| {
        h.pid == expected.pid && h.launch_id.as_deref() == Some(expected.launch_id.as_str())
    })
}

/// `CONTROL_PLANE_HOME/server.lock` de un server vivo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub pid: u32,
    pub port: u16,
    pub started_at: u64,
}

pub fn read_lock(home: &Path) -> Option<LockInfo> {
    serde_json::from_str(&fs::read_to_string(home.join("server.lock")).ok()?).ok()
}

/// El server murió porque la carpeta de datos ya la usa otro.
pub fn is_lock_error(log_tail: &[String]) -> bool {
    log_tail
        .iter()
        .any(|l| l.contains("Ya hay un control-plane usando esta carpeta de datos"))
}

/// El server murió porque no encontró `claude`.
pub fn is_claude_error(log_tail: &[String]) -> bool {
    log_tail
        .iter()
        .any(|l| l.contains("No encontré el binario de Claude Code"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health(pid: u32, launch: Option<&str>, port: u16) -> Health {
        Health {
            app: "control-plane".into(),
            version: "0.1.0".into(),
            pid,
            port,
            started_at: 1,
            launch_id: launch.map(str::to_string),
        }
    }

    fn state(pid: u32, launch: &str, port: u16) -> StateFile {
        StateFile {
            pid,
            pgid: None,
            launch_id: launch.into(),
            port,
            started_at: 1,
            log_path: "/tmp/x.log".into(),
            log_offset: 0,
        }
    }

    #[test]
    fn owner_table() {
        let s = state(10, "L1", 4711);
        // Sin archivo: ajeno, aunque traiga launchId.
        assert_eq!(owner(None, &health(10, Some("L1"), 4711)), Owner::Foreign);
        // Todo igual: propio.
        assert_eq!(owner(Some(&s), &health(10, Some("L1"), 4711)), Owner::Own);
        // Otro launchId, sin launchId, otro pid (pid reusado o server reiniciado), otro puerto.
        assert_eq!(
            owner(Some(&s), &health(10, Some("L2"), 4711)),
            Owner::Foreign
        );
        assert_eq!(owner(Some(&s), &health(10, None, 4711)), Owner::Foreign);
        assert_eq!(
            owner(Some(&s), &health(11, Some("L1"), 4711)),
            Owner::Foreign
        );
        assert_eq!(
            owner(Some(&s), &health(10, Some("L1"), 4712)),
            Owner::Foreign
        );
    }

    #[test]
    fn signals_need_a_fresh_matching_health() {
        let e = Expected {
            pid: 10,
            launch_id: "L1".into(),
            pgid: 10,
        };
        assert!(may_signal(&e, Some(&health(10, Some("L1"), 4711)), false));
        assert!(!may_signal(&e, None, false));
        assert!(!may_signal(&e, Some(&health(10, Some("L2"), 4711)), false));
        assert!(!may_signal(&e, Some(&health(99, Some("L1"), 4711)), false));
        assert!(!may_signal(&e, Some(&health(10, None, 4711)), false));
        // Hijo directo sin cosechar: su pid no se puede reusar.
        assert!(may_signal(&e, None, true));
    }

    #[test]
    fn state_file_roundtrip_and_broken() {
        let dir = tempfile::tempdir().unwrap();
        let p = state_path(dir.path(), 4711);
        assert!(p.ends_with("server-4711.json"));
        assert_eq!(StateFile::read(&p), None);
        let s = state(10, "L1", 4711);
        s.write(&p).unwrap();
        assert_eq!(StateFile::read(&p), Some(s));
        fs::write(&p, "{roto").unwrap();
        assert_eq!(StateFile::read(&p), None);
        StateFile::remove(&p);
        assert!(!p.exists());
    }

    #[test]
    fn old_state_files_without_pgid_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let p = state_path(dir.path(), 4711);
        fs::write(
            &p,
            r#"{"pid":5,"launchId":"L","port":4711,"startedAt":1,"logPath":"/x","logOffset":0}"#,
        )
        .unwrap();
        assert_eq!(StateFile::read(&p).unwrap().pgid, None);
    }

    #[test]
    fn lock_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_lock(dir.path()), None);
        fs::write(
            dir.path().join("server.lock"),
            r#"{"pid":321,"port":4713,"startedAt":1790000000000}"#,
        )
        .unwrap();
        assert_eq!(
            read_lock(dir.path()),
            Some(LockInfo {
                pid: 321,
                port: 4713,
                started_at: 1790000000000
            })
        );
        fs::write(dir.path().join("server.lock"), "{").unwrap();
        assert_eq!(read_lock(dir.path()), None);
    }

    #[test]
    fn exit_reasons_from_the_log() {
        let lock = vec![
            "algo".to_string(),
            "Ya hay un control-plane usando esta carpeta de datos en el puerto 4713 (pid 321). Detenelo o usá otro CONTROL_PLANE_HOME.".to_string(),
        ];
        assert!(is_lock_error(&lock) && !is_claude_error(&lock));
        let claude = vec![
            "No encontré el binario de Claude Code (\"x\"). Instalalo o definí CLAUDE_BIN."
                .to_string(),
        ];
        assert!(is_claude_error(&claude) && !is_lock_error(&claude));
    }
}
