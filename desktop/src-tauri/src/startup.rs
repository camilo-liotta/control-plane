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
/// Con `--quit`: salir dejando el server corriendo.
pub const KEEP_SERVER_ARG: &str = "--keep-server";
/// Con `--quit`: para actualizar. El server guarda las sesiones activas, se detiene y la app sale;
/// la app nueva lanza el server nuevo, que las retoma.
pub const RESTART_FOR_UPDATE_ARG: &str = "--restart-for-update";

/// Lo que muestra `--help`. `install.sh` y `get.sh` buscan "--quit --restart-for-update" (y
/// "--quit --keep-server", en las anteriores) en el binario instalado para saber si lo entiende, sin ejecutarlo: este texto es lo que lo deja ahí (una comparación de
/// strings cortos el compilador la hace con números). No lo saques sin cambiar el script.
pub const USAGE: &str = "\
control-plane: el dashboard de control-plane en una ventana propia.

  control-plane-desktop                       abre la app (o trae al frente la que está abierta)
  control-plane-desktop --hidden              la abre escondida: solo el ícono, sin ventana
  control-plane-desktop --quit                sale como con \"Salir\" (según \"Al salir\")
  control-plane-desktop --quit --keep-server  sale sin preguntar y deja el server corriendo
  control-plane-desktop --quit --restart-for-update
                                              para actualizar: guarda las sesiones activas,
                                              detiene el server y sale (la app nueva las retoma)
  control-plane-desktop --help                esta ayuda
";
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
    #[cfg(windows)]
    return windows_store::is_enabled(
        windows_autostart::RUN_KEY,
        windows_autostart::APPROVED_KEY,
        windows_autostart::value_name(),
    )
    .unwrap_or_else(|e| {
        eprintln!("No pude leer el inicio automático: {e}");
        false
    });
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
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe
            .to_str()
            .ok_or("la ruta del ejecutable no es texto válido")?;
        return windows_store::set(
            windows_autostart::RUN_KEY,
            windows_autostart::APPROVED_KEY,
            windows_autostart::value_name(),
            exe,
            on,
        );
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
             Comment=Abre control-plane escondida, solo con su ícono en la barra de arriba\n\
             Exec={}\n\
             Icon=control-plane-desktop\n\
             Terminal=false\n\
             X-GNOME-Autostart-enabled=true\n",
            string_value(&exec)
        ))
    }
}

/// El inicio automático en Windows: un valor propio en `HKCU\...\Run` (sin tocar los demás) y el
/// interruptor del Administrador de tareas en `StartupApproved\Run`. Lo que decide qué se escribe y
/// cómo se lee es puro (se prueba en cualquier sistema); el registro está en `sys::registry`.
#[cfg(any(windows, test))]
pub mod windows_autostart {
    use super::{autostart_name, HIDDEN_ARG};

    pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    pub const APPROVED_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    /// El nombre del valor en ambas claves (el de desarrollo, aparte).
    pub fn value_name() -> &'static str {
        autostart_name()
    }

    /// La línea de comandos que ejecuta el Explorador al iniciar sesión: la ruta siempre entre
    /// comillas y `--hidden`. Una ruta con `"` o con caracteres de control no se escribe.
    pub fn run_value(exe: &str) -> Result<String, String> {
        if exe.is_empty() {
            return Err("la ruta del ejecutable está vacía".into());
        }
        if exe.contains('"') || exe.chars().any(char::is_control) {
            return Err("la ruta tiene comillas o caracteres de control".into());
        }
        Ok(format!("\"{exe}\" {HIDDEN_ARG}"))
    }

    /// `StartupApproved\Run`: si el primer byte es par (0x02, 0x06) está habilitado; impar (0x03,
    /// 0x07) lo apagó el usuario. Sin valor, o vacío, nadie lo tocó: habilitado.
    pub fn approved(data: Option<&[u8]>) -> bool {
        match data.and_then(|d| d.first()) {
            Some(b) => b % 2 == 0,
            None => true,
        }
    }

    /// Prendido de verdad: hay valor en `Run` y el Administrador de tareas no lo apagó.
    pub fn enabled(run: Option<&str>, approved_data: Option<&[u8]>) -> bool {
        run.is_some_and(|r| !r.trim().is_empty()) && approved(approved_data)
    }
}

/// Windows: lee y escribe el registro con las reglas de [`windows_autostart`]. Las claves y el
/// nombre llegan por parámetro para probarlo contra una clave de prueba.
#[cfg(windows)]
mod windows_store {
    use crate::sys::registry;

    use super::windows_autostart::{enabled, run_value};

    pub fn is_enabled(run_key: &str, approved_key: &str, name: &str) -> Result<bool, String> {
        let run = registry::get_string(run_key, name).map_err(|e| e.to_string())?;
        let flag = registry::get_binary(approved_key, name).map_err(|e| e.to_string())?;
        Ok(enabled(run.as_deref(), flag.as_deref()))
    }

    /// Prende (escribe el valor y borra la marca de "apagado" del Administrador de tareas) o apaga
    /// (borra ambos). Solo toca el valor propio; con una ruta inválida no escribe nada.
    pub fn set(
        run_key: &str,
        approved_key: &str,
        name: &str,
        exe: &str,
        on: bool,
    ) -> Result<(), String> {
        let err = |e: std::io::Error| e.to_string();
        if !on {
            registry::delete_value(run_key, name).map_err(err)?;
            return registry::delete_value(approved_key, name).map_err(err);
        }
        let value = run_value(exe)?;
        registry::set_string(run_key, name, &value).map_err(err)?;
        registry::delete_value(approved_key, name).map_err(err)
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
    fn usage_names_the_flags_the_installer_looks_for() {
        assert!(USAGE.contains(&format!("--quit {KEEP_SERVER_ARG}")));
        assert!(USAGE.contains(&format!("--quit {RESTART_FOR_UPDATE_ARG}")));
        assert!(USAGE.contains(HIDDEN_ARG));
    }

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

    #[test]
    fn windows_run_value_quotes_the_exe_and_starts_hidden() {
        use windows_autostart::run_value;
        assert_eq!(
            run_value(r"C:\Program Files\X\a.exe").unwrap(),
            r#""C:\Program Files\X\a.exe" --hidden"#
        );
        assert_eq!(
            run_value(r"C:\Users\Ñandú\App (x86)\cp.exe").unwrap(),
            r#""C:\Users\Ñandú\App (x86)\cp.exe" --hidden"#
        );
        assert_eq!(run_value(r"C:\a.exe").unwrap(), r#""C:\a.exe" --hidden"#);
    }

    #[test]
    fn windows_run_value_rejects_quotes_and_control_chars() {
        use windows_autostart::run_value;
        assert!(run_value("C:\\a\"b.exe").is_err());
        assert!(run_value("C:\\a\nb.exe").is_err());
        assert!(run_value("C:\\a\u{7}b.exe").is_err());
        assert!(run_value("").is_err());
    }

    #[test]
    fn windows_startup_approved_first_byte_decides() {
        use windows_autostart::approved;
        // Sin valor o vacío: habilitado (Windows no escribió nada).
        assert!(approved(None));
        assert!(approved(Some(&[])));
        // 0x02 y 0x06: habilitado; 0x03 y 0x07: lo apagó el usuario en el Administrador de tareas.
        assert!(approved(Some(&[0x02, 0, 0, 0])));
        assert!(approved(Some(&[0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        assert!(!approved(Some(&[0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        assert!(!approved(Some(&[0x07])));
    }

    #[test]
    fn windows_autostart_is_on_only_with_a_run_value_that_is_approved() {
        use windows_autostart::enabled;
        let on = Some(&[0x02u8, 0, 0, 0][..]);
        let off = Some(&[0x03u8, 0, 0, 0][..]);
        let run = Some("\"C:\\a.exe\" --hidden");
        assert!(enabled(run, None));
        assert!(enabled(run, on));
        assert!(!enabled(run, off));
        assert!(!enabled(None, None));
        assert!(!enabled(None, on));
        assert!(!enabled(Some("   "), None));
    }

    #[test]
    fn windows_dev_builds_use_their_own_value_name() {
        assert_eq!(windows_autostart::value_name(), autostart_name());
        // Los tests corren en debug: el nombre de producción no se toca.
        assert_eq!(windows_autostart::value_name(), "control-plane-dev");
    }

    /// Windows, contra una clave de prueba: prender, apagar, el interruptor del Administrador de
    /// tareas y lo que no se toca.
    #[cfg(windows)]
    #[test]
    fn windows_autostart_roundtrip_in_a_scratch_key() {
        use crate::sys::registry::{get_binary, get_string, set_raw, set_string, Scratch};
        use windows_sys::Win32::System::Registry::REG_BINARY;

        let scratch = Scratch::new();
        let (run, approved) = (scratch.child("Run"), scratch.child("Approved"));
        let exe = r"C:\Program Files\X\a.exe";
        let is_on = || windows_store::is_enabled(&run, &approved, "cp").unwrap();

        assert!(!is_on());
        // Un valor ajeno no se toca nunca.
        set_string(&run, "otra-app", "otra.exe").unwrap();

        windows_store::set(&run, &approved, "cp", exe, true).unwrap();
        assert!(is_on());
        assert_eq!(
            get_string(&run, "cp").unwrap().as_deref(),
            Some(r#""C:\Program Files\X\a.exe" --hidden"#)
        );

        // Lo apagó el usuario en el Administrador de tareas: el valor sigue, pero no está prendido.
        set_raw(
            &approved,
            "cp",
            REG_BINARY,
            &[0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        )
        .unwrap();
        assert!(!is_on());
        // Prenderlo desde la app borra esa marca (lo pide el usuario, explícito).
        windows_store::set(&run, &approved, "cp", exe, true).unwrap();
        assert!(is_on());
        assert_eq!(get_binary(&approved, "cp").unwrap(), None);

        // Apagar borra los dos valores, y repetirlo no falla.
        set_raw(&approved, "cp", REG_BINARY, &[0x02, 0, 0, 0]).unwrap();
        windows_store::set(&run, &approved, "cp", exe, false).unwrap();
        assert!(!is_on());
        assert_eq!(get_string(&run, "cp").unwrap(), None);
        assert_eq!(get_binary(&approved, "cp").unwrap(), None);
        windows_store::set(&run, &approved, "cp", exe, false).unwrap();
        assert_eq!(
            get_string(&run, "otra-app").unwrap().as_deref(),
            Some("otra.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_autostart_refuses_a_bad_path_and_writes_nothing() {
        use crate::sys::registry::{get_string, Scratch};
        let scratch = Scratch::new();
        let (run, approved) = (scratch.child("Run"), scratch.child("Approved"));
        assert!(windows_store::set(&run, &approved, "cp", "C:\\a\"b.exe", true).is_err());
        assert_eq!(get_string(&run, "cp").unwrap(), None);
    }
}
