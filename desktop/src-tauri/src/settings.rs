//! Ajustes de la app (`settings.json` en la carpeta de configuración de la app).
//!
//! Un archivo roto, viejo o con un campo inválido nunca impide arrancar: cada campo se lee por
//! separado y, si no sirve, queda su valor por defecto.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};

pub const FILE_NAME: &str = "settings.json";

/// Qué hacer al salir si la app lanzó el server.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnExit {
    /// Preguntar cada vez (detener, dejarlo corriendo o cancelar).
    #[default]
    Ask,
    /// Detener el server (y con él las sesiones).
    Stop,
    /// Dejar el server corriendo.
    Leave,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Puerto del server. `None`: el de siempre (4700; 4710 en desarrollo).
    pub port: Option<u16>,
    pub on_exit: OnExit,
    /// Notificaciones nativas prendidas.
    pub notifications: bool,
    /// Node elegido a mano (si no, el del PATH de la shell de login).
    pub node_path: Option<PathBuf>,
    /// Variables extra de la shell de login que se le pasan al server (además de la lista blanca).
    pub import_env: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: None,
            on_exit: OnExit::Ask,
            notifications: true,
            node_path: None,
            import_env: Vec::new(),
        }
    }
}

impl Settings {
    /// Lee los ajustes de un JSON cualquiera, campo por campo.
    pub fn from_json(text: &str) -> Self {
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        let d = Self::default();
        Self {
            port: field(&map, "port", d.port).filter(|p| *p != 0),
            on_exit: field(&map, "onExit", d.on_exit),
            notifications: field(&map, "notifications", d.notifications),
            node_path: field(&map, "nodePath", d.node_path),
            import_env: field(&map, "importEnv", d.import_env),
        }
    }

    pub fn load_from(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(text) => Self::from_json(&text),
            Err(_) => Self::default(),
        }
    }

    /// Guarda de forma atómica (archivo temporal + rename).
    pub fn save_to(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        fs::write(&tmp, text + "\n")?;
        fs::rename(&tmp, path)
    }
}

fn field<T: DeserializeOwned>(map: &Map<String, Value>, key: &str, default: T) -> T {
    map.get(key)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(default)
}

pub fn path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(FILE_NAME))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    path(app)
        .map(|p| Settings::load_from(&p))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broken_or_missing_file_gives_defaults() {
        assert_eq!(Settings::from_json(""), Settings::default());
        assert_eq!(Settings::from_json("{no es json"), Settings::default());
        assert_eq!(Settings::from_json("[1,2]"), Settings::default());
        assert_eq!(Settings::from_json("null"), Settings::default());
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            Settings::load_from(&dir.path().join("nada.json")),
            Settings::default()
        );
    }

    #[test]
    fn bad_fields_fall_back_one_by_one() {
        let s = Settings::from_json(
            r#"{"port":"4710","onExit":"explotar","notifications":false,"importEnv":["AWS_PROFILE"],"viejo":1}"#,
        );
        assert_eq!(s.port, None);
        assert_eq!(s.on_exit, OnExit::Ask);
        assert!(!s.notifications);
        assert_eq!(s.import_env, vec!["AWS_PROFILE".to_string()]);
    }

    #[test]
    fn port_out_of_range_or_zero_is_ignored() {
        assert_eq!(Settings::from_json(r#"{"port":70000}"#).port, None);
        assert_eq!(Settings::from_json(r#"{"port":-1}"#).port, None);
        assert_eq!(Settings::from_json(r#"{"port":0}"#).port, None);
        assert_eq!(Settings::from_json(r#"{"port":4800}"#).port, Some(4800));
    }

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join(FILE_NAME);
        let s = Settings {
            port: Some(4800),
            on_exit: OnExit::Leave,
            notifications: false,
            node_path: Some(PathBuf::from("/opt/node/bin/node")),
            import_env: vec!["AWS_PROFILE".into()],
        };
        s.save_to(&file).unwrap();
        assert_eq!(Settings::load_from(&file), s);
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"onExit\": \"leave\""));
    }
}
