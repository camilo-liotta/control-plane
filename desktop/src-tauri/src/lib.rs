//! App de escritorio de control-plane: una ventana propia para el dashboard que sirve el server.

pub mod launch_env;
pub mod login_env;
pub mod node;
pub mod settings;
pub mod window;

use tauri::{Manager, WindowEvent};

use crate::settings::Settings;
use crate::window::PortError;

/// Estado compartido de la app.
pub struct AppState {
    pub settings: Settings,
    /// Puerto del server, o por qué no hay uno válido.
    pub port: Result<u16, PortError>,
}

pub fn run() {
    tauri::Builder::default()
        // Primero: una segunda apertura enfoca la ventana que ya está y termina.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::show_main(app);
        }))
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
                settings,
                port: port.clone(),
            });
            app.manage(launch);

            // T3: descubrir o lanzar el server y supervisarlo.
            window::create_main(handle, port)?;
            // T4: bandeja, notificaciones nativas y autostart.
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
        .build(tauri::generate_context!())
        .expect("no pude iniciar la app")
        .run(|_app, _event| match _event {
            // macOS: clic en el ícono del Dock con la ventana escondida.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => window::show_main(_app),
            // T3: RunEvent::ExitRequested → preguntar qué hacer con el server antes de salir.
            _ => {}
        });
}
