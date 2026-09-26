//! App de escritorio de control-plane: una ventana propia para el dashboard que sirve el server.

pub mod desktop_ws;
pub mod launch_env;
pub mod login_env;
pub mod node;
pub mod notify;
pub mod settings;
pub mod startup;
pub mod tray;
pub mod window;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, WindowEvent};

use crate::desktop_ws::{DesktopWs, WsEvent};
use crate::settings::Settings;
use crate::window::PortError;

/// Estado compartido de la app.
pub struct AppState {
    /// Se cambian desde el menú de la bandeja; [`AppState::update_settings`] los guarda.
    pub settings: Mutex<Settings>,
    /// Dónde se guardan (`None` si no hay carpeta de configuración).
    pub settings_path: Option<PathBuf>,
    /// Puerto del server, o por qué no hay uno válido.
    pub port: Result<u16, PortError>,
}

impl AppState {
    /// Una copia de los ajustes actuales.
    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// Cambia los ajustes y los guarda.
    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) {
        let mut s = self.settings.lock().unwrap();
        f(&mut s);
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
        }
        WsEvent::Toast(toast) => notify::handle(app, toast),
    }
}

pub fn run() {
    let context = tauri::generate_context!();
    // Linux: una segunda apertura con token de activación se lo pasa a la primera y termina.
    #[cfg(target_os = "linux")]
    if startup::forward_to_running(&context.config().identifier) {
        return;
    }

    tauri::Builder::default()
        // Primero: una segunda apertura enfoca la ventana que ya está y termina.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
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
        .setup(|app| {
            let handle = app.handle();
            let settings = settings::load(handle);
            // Entorno de la shell de login (PATH y lista blanca), node y claude: lo usa T3.
            let launch = launch_env::LaunchEnv::prepare(&settings);
            eprintln!("{}", launch.summary());
            let port = window::port_from_env(launch.login_var("CONTROL_PLANE_PORT"), settings.port);
            if let Err(e) = &port {
                eprintln!("{e}");
            }
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path: settings::path(handle),
                port: port.clone(),
            });
            app.manage(launch);

            // T3: descubrir o lanzar el server y supervisarlo.
            window::create_main(handle, port.clone())?;

            // Bandeja, avisos y WS de escritorio. T3 reconecta el WS cuando lanza o adopta un
            // server: `app.state::<DesktopWs>().reconnect(Some(puerto))`.
            tray::init(handle)?;
            notify::init(handle);
            let events = handle.clone();
            app.manage(DesktopWs::start(port.ok(), move |e| {
                on_ws_event(&events, e)
            }));
            Ok(())
        })
        .on_window_event(|win, event| {
            // Cerrar la ventana la esconde: el server y las sesiones siguen.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if win.label() == window::MAIN {
                    api.prevent_close();
                    let _ = win.hide();
                }
            }
        })
        .build(context)
        .expect("no pude iniciar la app")
        .run(|_app, _event| match _event {
            // macOS: clic en el ícono del Dock con la ventana escondida.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => window::show_main(_app),
            // T3: RunEvent::ExitRequested → preguntar qué hacer con el server antes de salir
            // (también llega desde "Salir" en la bandeja, que llama a app.exit(0)).
            _ => {}
        });
}
