//! Cómo arranca la app: sola al iniciar sesión (escondida, solo la bandeja) o abierta a mano.
//!
//! El inicio automático lo maneja `tauri-plugin-autostart`: en Linux escribe
//! `~/.config/autostart/<nombre>.desktop` (siempre bajo `$HOME`, no mira `XDG_CONFIG_HOME`); en
//! macOS, un LaunchAgent en `~/Library/LaunchAgents/<nombre>.plist`. Los dos lanzan la app con
//! [`HIDDEN_ARG`].
//!
//! En GNOME con Wayland, una ventana solo pasa al frente con un token de activación
//! (`xdg-activation`). La segunda apertura lo recibe en `XDG_ACTIVATION_TOKEN`, pero
//! `tauri-plugin-single-instance` le pasa a la primera solo los argumentos: acá se lo agrega como
//! argumento ([`TOKEN_ARG`]).

use tauri::plugin::TauriPlugin;
use tauri::Runtime;

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

pub fn autostart_plugin<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri_plugin_autostart::Builder::new()
        .app_name(autostart_name())
        .arg(HIDDEN_ARG);
    #[cfg(target_os = "macos")]
    let builder = builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    builder.build()
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
