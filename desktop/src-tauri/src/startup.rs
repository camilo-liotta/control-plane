//! Cómo arranca la app: sola al iniciar sesión (escondida, solo la bandeja) o abierta a mano.
//!
//! Inicio automático, siempre con [`HIDDEN_ARG`]:
//! - Linux: un `.desktop` propio en `$XDG_CONFIG_HOME/autostart/` (o `~/.config/autostart/`). Si
//!   la app corre desde un AppImage, `Exec` apunta al `.AppImage` (`$APPIMAGE`), no al binario
//!   montado en `/tmp/.mount_*`, que cambia en cada arranque; la ruta va entre comillas según la
//!   spec de Desktop Entry, así sobrevive a espacios y caracteres raros.
//! - macOS: `tauri-plugin-autostart`, un LaunchAgent en `~/Library/LaunchAgents/<nombre>.plist`.
//!
//! En GNOME con Wayland, una ventana solo pasa al frente con un token de activación
//! (`xdg-activation`). La segunda apertura lo recibe en `XDG_ACTIVATION_TOKEN`, pero
//! `tauri-plugin-single-instance` le pasa a la primera solo los argumentos: acá se lo agrega como
//! argumento ([`TOKEN_ARG`]).

use tauri::{AppHandle, Runtime};

pub const HIDDEN_ARG: &str = "--hidden";
pub const TOKEN_ARG: &str = "--activation-token=";

/// Con qué nombre queda el inicio automático (el de desarrollo, aparte).
fn autostart_name() -> &'static str {
    if cfg!(debug_assertions) {
        "control-plane-dev"
    } else {
        "control-plane"
    }
}

/// macOS: el plugin del LaunchAgent. En el resto no hace nada (Linux escribe su `.desktop`).
pub fn autostart_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    #[cfg(target_os = "macos")]
    return tauri_plugin_autostart::Builder::new()
        .app_name(autostart_name())
        .arg(HIDDEN_ARG)
        .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
        .build();
    #[cfg(not(target_os = "macos"))]
    tauri::plugin::Builder::new("autostart").build()
}

/// ¿Está prendido el inicio automático?
pub fn autostart_enabled<R: Runtime>(_app: &AppHandle<R>) -> bool {
    #[cfg(target_os = "linux")]
    return linux_autostart::file().is_some_and(|f| f.exists());
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        return _app.autolaunch().is_enabled().unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

/// Prende o apaga el inicio automático.
pub fn set_autostart<R: Runtime>(_app: &AppHandle<R>, on: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let file = linux_autostart::file().ok_or("no encuentro la carpeta de configuración")?;
        if !on {
            return match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let exe = match tauri::Manager::env(_app).appimage {
            Some(appimage) => std::path::PathBuf::from(appimage),
            None => std::env::current_exe().map_err(|e| e.to_string())?,
        };
        let text = linux_autostart::entry(&exe.to_string_lossy())?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        return std::fs::write(&file, text).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        let auto = _app.autolaunch();
        let res = if on { auto.enable() } else { auto.disable() };
        return res.map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    {
        let _ = on;
        Err("no disponible en este sistema".into())
    }
}

/// El `.desktop` de inicio automático en Linux (sin tocar disco: se prueba solo).
pub mod linux_autostart {
    use std::path::PathBuf;

    use super::{autostart_name, HIDDEN_ARG};

    /// `$XDG_CONFIG_HOME/autostart/<nombre>.desktop`, o `~/.config/autostart/…`.
    pub fn file() -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(
            config
                .join("autostart")
                .join(format!("{}.desktop", autostart_name())),
        )
    }

    /// Un argumento de `Exec`: entre comillas si hace falta, con `"`, `` ` ``, `$` y `\`
    /// escapados, y `%` duplicado (spec de Desktop Entry, "The Exec key").
    pub fn exec_arg(arg: &str) -> Result<String, String> {
        if arg.chars().any(char::is_control) {
            return Err("la ruta tiene caracteres de control".into());
        }
        const RESERVED: &str = " \t\"'\\><~|&;$*?#()`";
        let arg = arg.replace('%', "%%");
        if !arg.is_empty() && !arg.chars().any(|c| RESERVED.contains(c)) {
            return Ok(arg);
        }
        let mut out = String::from("\"");
        for c in arg.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
        Ok(out)
    }

    /// El valor de una clave de tipo string: la barra invertida se escapa otra vez.
    fn string_value(s: &str) -> String {
        s.replace('\\', "\\\\")
    }

    pub fn entry(exe: &str) -> Result<String, String> {
        let exec = format!("{} {HIDDEN_ARG}", exec_arg(exe)?);
        Ok(format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=control-plane\n\
             Comment=Abre control-plane escondida, solo en la bandeja\n\
             Exec={}\n\
             Icon=control-plane-desktop\n\
             Terminal=false\n\
             X-GNOME-Autostart-enabled=true\n",
            string_value(&exec)
        ))
    }
}

/// ¿Arrancó sola al iniciar sesión?
pub fn is_hidden<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter().any(|a| a.as_ref() == HIDDEN_ARG)
}

pub fn started_hidden() -> bool {
    is_hidden(&std::env::args().collect::<Vec<_>>())
}

/// El token de activación que trae una segunda apertura en sus argumentos.
pub fn activation_token<S: AsRef<str>>(args: &[S]) -> Option<String> {
    args.iter()
        .rev()
        .find_map(|a| a.as_ref().strip_prefix(TOKEN_ARG))
        .filter(|t| !t.is_empty() && t.len() <= 512 && !t.chars().any(char::is_control))
        .map(str::to_string)
}

/// Linux: si ya hay una instancia corriendo y esta apertura trae token de activación, le pasa los
/// argumentos con el token por el mismo D-Bus que usa `tauri-plugin-single-instance` y devuelve
/// `true` (hay que terminar). Si no, no hace nada y el plugin sigue como siempre.
#[cfg(target_os = "linux")]
pub fn forward_to_running(identifier: &str) -> bool {
    let Some(token) = std::env::var("XDG_ACTIVATION_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
    else {
        return false;
    };
    let name = format!("{identifier}.SingleInstance");
    let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
    let Ok(conn) = zbus::blocking::Connection::session() else {
        return false;
    };
    let mut argv: Vec<String> = std::env::args().collect();
    argv.push(format!("{TOKEN_ARG}{token}"));
    let cwd = std::env::current_dir().unwrap_or_default();
    conn.call_method(
        Some(name.as_str()),
        path.as_str(),
        Some("org.SingleInstance.DBus"),
        "ExecuteCallback",
        &(argv, cwd.to_string_lossy().as_ref()),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_flag() {
        assert!(is_hidden(&["app", "--hidden"]));
        assert!(!is_hidden(&["app"]));
        assert!(!is_hidden(&["app", "--hidden=no"]));
    }

    #[test]
    fn autostart_exec_is_quoted_when_needed() {
        use linux_autostart::exec_arg;
        assert_eq!(
            exec_arg("/usr/bin/control-plane-desktop").unwrap(),
            "/usr/bin/control-plane-desktop"
        );
        assert_eq!(
            exec_arg("/home/u/Mis Apps/control-plane.AppImage").unwrap(),
            r#""/home/u/Mis Apps/control-plane.AppImage""#
        );
        assert_eq!(exec_arg(r#"/a/$b"c`d\e"#).unwrap(), r#""/a/\$b\"c\`d\\e""#);
        assert_eq!(exec_arg("/a/100%").unwrap(), "/a/100%%");
        assert!(exec_arg("/a\nb").is_err());
    }

    #[test]
    fn autostart_entry_points_to_the_exe_and_starts_hidden() {
        let text = linux_autostart::entry("/opt/Mis Apps/cp.AppImage").unwrap();
        assert!(
            text.contains("Exec=\"/opt/Mis Apps/cp.AppImage\" --hidden\n"),
            "{text}"
        );
        // En el archivo, la barra de un escape va doble (el valor es un string de Desktop Entry).
        let text = linux_autostart::entry(r#"/opt/a"b"#).unwrap();
        assert!(text.contains(r#"Exec="/opt/a\\"b" --hidden"#), "{text}");
        assert!(text.starts_with("[Desktop Entry]\nType=Application\n"));
    }

    #[test]
    fn token_from_args() {
        assert_eq!(activation_token(&["app"]), None);
        assert_eq!(
            activation_token(&["app", "--activation-token=abc_123"]).as_deref(),
            Some("abc_123")
        );
        assert_eq!(activation_token(&["app", "--activation-token="]), None);
        assert_eq!(activation_token(&["app", "--activation-token=a\nb"]), None);
    }
}
