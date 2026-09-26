//! App de escritorio de control-plane: una ventana propia para el dashboard que sirve el server.

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod app_menu;
pub mod bundle_copy;
pub mod desktop_ws;
mod drop;
pub mod health;
pub mod launch_env;
pub mod launcher;
pub mod login_env;
#[cfg(target_os = "macos")]
mod macos;
pub mod node;
pub mod notify;
pub mod policy;
pub mod screen;
pub mod server_log;
pub mod server_state;
pub mod settings;
pub mod sidecar;
pub mod startup;
pub mod tray;
pub mod window;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};

use crate::desktop_ws::{DesktopWs, Toast, WsEvent};
use crate::settings::Settings;
use crate::sidecar::{Hooks, Sidecar};

/// Estado compartido de la app.
pub struct AppState {
    /// Se cambian desde el menú de la bandeja; [`AppState::update_settings`] los guarda.
    pub settings: Mutex<Settings>,
    /// Dónde se guardan (`None` si no hay carpeta de configuración).
    pub settings_path: Option<PathBuf>,
}

impl AppState {
    /// Una copia de los ajustes actuales.
    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// Cambia los ajustes y los guarda.
    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) {
        let s = {
            let mut s = self.settings.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        if let Some(path) = &self.settings_path {
            if let Err(e) = s.save_to(path) {
                eprintln!("No pude guardar los ajustes: {e}");
            }
        }
    }
}

/// Lo que llega del WS de escritorio: la bandeja refleja el estado y los toasts van a avisos.
fn on_ws_event<R: Runtime>(app: &AppHandle<R>, event: WsEvent) {
    match event {
        WsEvent::Changed(snap) => {
            if let Some(tray) = app.try_state::<tray::Tray<R>>() {
                tray.refresh(&snap);
            }
            if let Some(l) = app.try_state::<launcher::Launcher>() {
                l.set(launcher::badge(&snap));
            }
        }
        WsEvent::Toast(toast) => notify::handle(app, toast),
    }
}

/// Lo que el sidecar le avisa al resto de la app: el WS de escritorio se reconecta con cada
/// server nuevo, las caídas van a avisos nativos y el diálogo de salida cuenta las sesiones.
fn hooks() -> Hooks {
    Hooks {
        on_server: Box::new(|app, port| app.state::<DesktopWs>().reconnect(port)),
        notify: Box::new(|app, title, body| {
            notify::handle(
                app,
                Toast {
                    level: "warn".into(),
                    title: title.into(),
                    body: Some(body.into()),
                    ..Default::default()
                },
            )
        }),
        running: Box::new(|app| {
            app.state::<DesktopWs>()
                .snapshot()
                .summary
                .map(|s| s.running)
        }),
    }
}

#[cfg(debug_assertions)]
fn test_action(argv: &[String]) -> Option<screen::Request> {
    let arg = |name: &str| {
        argv.iter()
            .position(|a| a == name)
            .and_then(|i| argv.get(i + 1))
    };
    Some(screen::Request {
        action: screen::Action::from_id(arg("--action")?)?,
        port: arg("--port").and_then(|p| p.parse().ok()),
    })
}

pub fn run() {
    let context = tauri::generate_context!();
    // Linux: una segunda apertura con token de activación se lo pasa a la primera y termina.
    #[cfg(target_os = "linux")]
    if startup::forward_to_running(&context.config().identifier) {
        return;
    }

    let builder = tauri::Builder::default();
    // macOS: un "Salir" (Cmd+Q) que pasa por la decisión sobre el server.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| app_menu::build(app));
    builder
        // Primero: una segunda apertura enfoca la ventana que ya está y termina.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `control-plane --quit` desde una terminal: salir como con "Salir" (pasa por la
            // decisión sobre el server).
            if argv.iter().any(|a| a == "--quit") {
                app.exit(0);
                return;
            }
            // Solo en desarrollo: `--action <id> [--port N]` aprieta un botón de la pantalla
            // local (para probar los flujos sin mouse).
            #[cfg(debug_assertions)]
            if let Some(req) = test_action(&argv) {
                app.state::<Sidecar>().action(req);
                return;
            }
            let handle = app.clone();
            let token = startup::activation_token(&argv);
            eprintln!(
                "Otra apertura: muestro la ventana ({} token de activación).",
                if token.is_some() { "con" } else { "sin" }
            );
            let _ = app.run_on_main_thread(move || {
                window::show_main_with(&handle, token.as_deref());
            });
        }))
        .plugin(startup::autostart_plugin())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // `--quit` sin ninguna abierta: no hay nada que cerrar (y no se abre una).
            if std::env::args().any(|a| a == "--quit") {
                eprintln!("No hay ninguna control-plane abierta.");
                std::process::exit(0);
            }
            let handle = app.handle();
            #[cfg(target_os = "macos")]
            handle.on_menu_event(|app, event| app_menu::on_event(app, &event));
            app.manage(AppState {
                settings: Mutex::new(settings::load(handle)),
                settings_path: settings::path(handle),
            });

            // La ventana sale enseguida con "cargando"; el entorno de la shell de login, el
            // puerto y el server se resuelven en el hilo del sidecar.
            let inbox = sidecar::create(handle);
            let sc = handle.state::<Sidecar>();
            let actions = handle.clone();
            window::create_main(handle, sc.guard(), sc.token(), move |req| {
                actions.state::<Sidecar>().action(req)
            })?;
            #[cfg(target_os = "macos")]
            macos::watch_power_off(sc.system_ending_flag());

            // Bandeja, avisos y WS de escritorio (sin conexión hasta que el sidecar tenga server).
            tray::init(handle)?;
            notify::init(handle);
            app.manage(launcher::Launcher::start());
            let events = handle.clone();
            app.manage(DesktopWs::start(None, move |e| on_ws_event(&events, e)));
            sidecar::start(handle.clone(), inbox, hooks());
            Ok(())
        })
        .on_window_event(|win, event| {
            // Cerrar la ventana la esconde: el server y las sesiones siguen.
            match event {
                WindowEvent::CloseRequested { api, .. } if win.label() == window::MAIN => {
                    api.prevent_close();
                    let _ = win.hide();
                }
                // Con la ventana al frente, los avisos que quedaron en la lista ya se vieron.
                WindowEvent::Focused(true) if win.label() == window::MAIN => {
                    notify::dismiss_all(win.app_handle());
                }
                // Archivos soltados en la ventana: adjuntos para el chat abierto.
                WindowEvent::DragDrop(e) if win.label() == window::MAIN => drop::on_event(win, e),
                _ => {}
            }
        })
        .build(context)
        .expect("no pude iniciar la app")
        .run(|app, event| match event {
            // Cmd+Q, el menú de la app o "Salir" en la bandeja (que llama a app.exit(0)): el
            // sidecar decide qué hacer con el server y vuelve a pedir la salida si corresponde.
            RunEvent::ExitRequested { api, .. } if app.state::<Sidecar>().intercept_exit() => {
                api.prevent_exit();
            }
            // macOS: clic en el ícono del Dock con la ventana escondida.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => window::show_main(app),
            _ => {}
        });
}
