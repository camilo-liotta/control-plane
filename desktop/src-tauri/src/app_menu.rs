//! macOS: el menú de la app. El de Tauri trae "Salir" como `terminate:`, que cierra sin pasar por
//! `RunEvent::ExitRequested`: con Cmd+Q la app saldría sin decidir qué hacer con el server. Acá
//! "Salir" (Cmd+Q) es un ítem propio que pide la salida con `app.exit(0)`.
//!
//! Se compila en todas las plataformas (así la API queda verificada en Linux), pero solo se
//! instala en macOS. **Sin probar en una Mac todavía.**

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

pub const QUIT: &str = "app-quit";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let sep = || PredefinedMenuItem::separator(app);
    let quit = MenuItem::with_id(
        app,
        QUIT,
        format!("Salir de {name}"),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &quit,
        ],
    )?;
    // Sin este menú no andan copiar y pegar en la ventana.
    let edit = Submenu::with_items(
        app,
        "Edición",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Ventana",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    if event.id().as_ref() == QUIT {
        app.exit(0);
    }
}
