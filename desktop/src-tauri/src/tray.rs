//! Ícono en la bandeja (Linux) o en la barra de menú (macOS), con el estado del server y un menú.
//!
//! En Linux (appindicator) el ícono no recibe clics ni muestra tooltip: todo pasa por el menú, y la
//! primera línea del menú dice cómo están las cosas. En macOS el ícono es template y lleva al lado
//! cuántas cosas te necesitan.

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuBuilder, MenuEvent, MenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_autostart::ManagerExt;

use crate::desktop_ws::Snapshot;
use crate::settings::OnExit;
use crate::window;
use crate::AppState;

const OPEN: &str = "open";
const INBOX: &str = "inbox";
const NOTIFICATIONS: &str = "notifications";
const AUTOSTART: &str = "autostart";
const QUIT: &str = "quit";
const LOG: &str = "log";
const PROJECT_PREFIX: &str = "project:";
const EXIT_OPTIONS: [(OnExit, &str, &str); 3] = [
    (OnExit::Ask, "exit:ask", "Preguntar"),
    (OnExit::Stop, "exit:stop", "Detener el server"),
    (OnExit::Leave, "exit:leave", "Dejarlo corriendo"),
];

// ---- Modelo (sin widgets, se prueba solo) ----

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// La línea de estado: la primera del menú y el tooltip.
pub fn status_text(snap: &Snapshot) -> String {
    let Some(s) = snap.summary.as_ref().filter(|_| snap.connected) else {
        return "Sin conexión con el server".into();
    };
    let needs = (s.needs > 0).then(|| plural(s.needs, "te necesita", "te necesitan"));
    let working = (s.working > 0).then(|| format!("{} trabajando", s.working));
    match (needs, working) {
        (Some(n), Some(w)) => format!("{n} · {w}"),
        (Some(t), None) | (None, Some(t)) => t,
        (None, None) => "Todo tranquilo".into(),
    }
}

/// Lo que va al lado del ícono en macOS: cuántas cosas te necesitan.
pub fn title_text(snap: &Snapshot) -> Option<String> {
    let needs = snap.summary.as_ref().filter(|_| snap.connected)?.needs;
    (needs > 0).then(|| needs.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconKind {
    Calm,
    /// Con un punto: algo te necesita.
    Attention,
}

pub fn icon_kind(snap: &Snapshot) -> IconKind {
    match title_text(snap) {
        Some(_) => IconKind::Attention,
        None => IconKind::Calm,
    }
}

/// Un texto tal cual en un ítem de menú: `&` marca el atajo de teclado en muda.
pub fn menu_label(text: &str) -> String {
    text.replace('&', "&&")
}

/// La ruta de un proyecto, con el id escapado (viene del server, pero no se confía en él).
pub fn project_route(id: &str) -> String {
    let mut out = String::from("/p/");
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectsModel {
    Offline,
    Empty,
    /// (id del proyecto, texto del ítem).
    List(Vec<(String, String)>),
}

pub fn projects_model(snap: &Snapshot) -> ProjectsModel {
    let Some(s) = snap.summary.as_ref().filter(|_| snap.connected) else {
        return ProjectsModel::Offline;
    };
    if s.projects.is_empty() {
        return ProjectsModel::Empty;
    }
    ProjectsModel::List(
        s.projects
            .iter()
            .map(|p| {
                let label = if p.needs > 0 {
                    format!("{} ({})", p.name, p.needs)
                } else {
                    p.name.clone()
                };
                (p.id.clone(), menu_label(&label))
            })
            .collect(),
    )
}

/// Qué hacer con un clic en el menú.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Open,
    Inbox,
    Project(String),
    ToggleNotifications,
    ToggleAutostart,
    OnExit(OnExit),
    ShowLog,
    Quit,
    None,
}

pub fn action(id: &str) -> Action {
    if let Some(p) = id.strip_prefix(PROJECT_PREFIX) {
        return Action::Project(p.to_string());
    }
    if let Some((mode, ..)) = EXIT_OPTIONS.iter().find(|(_, key, _)| *key == id) {
        return Action::OnExit(*mode);
    }
    match id {
        OPEN => Action::Open,
        INBOX => Action::Inbox,
        NOTIFICATIONS => Action::ToggleNotifications,
        AUTOSTART => Action::ToggleAutostart,
        LOG => Action::ShowLog,
        QUIT => Action::Quit,
        _ => Action::None,
    }
}

// ---- Widgets ----

fn icon(kind: IconKind) -> Image<'static> {
    let bytes: &[u8] = match (cfg!(target_os = "macos"), kind) {
        (true, IconKind::Calm) => include_bytes!("../icons/tray/macos.png"),
        (true, IconKind::Attention) => include_bytes!("../icons/tray/macos-dot.png"),
        (false, IconKind::Calm) => include_bytes!("../icons/tray/linux.png"),
        (false, IconKind::Attention) => include_bytes!("../icons/tray/linux-dot.png"),
    };
    Image::from_bytes(bytes).expect("ícono de la bandeja válido")
}

struct Shown<R: Runtime> {
    status: String,
    icon: Option<IconKind>,
    title: Option<String>,
    projects: Option<ProjectsModel>,
    /// Los ítems de `ProjectsModel::List`, en el mismo orden.
    project_items: Vec<MenuItem<R>>,
}

/// Estado de Tauri: el ícono y los ítems que cambian.
pub struct Tray<R: Runtime> {
    icon: TrayIcon<R>,
    status: MenuItem<R>,
    projects: Submenu<R>,
    notifications: CheckMenuItem<R>,
    autostart: CheckMenuItem<R>,
    on_exit: Vec<(OnExit, CheckMenuItem<R>)>,
    shown: Mutex<Shown<R>>,
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let settings = app.state::<AppState>().settings();
    let status = MenuItem::new(app, status_text(&Snapshot::default()), false, None::<&str>)?;
    let projects = Submenu::new(app, "Proyectos", true)?;
    let notifications = CheckMenuItem::with_id(
        app,
        NOTIFICATIONS,
        "Avisos",
        true,
        settings.notifications,
        None::<&str>,
    )?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        AUTOSTART,
        "Abrir al iniciar sesión",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let on_exit = EXIT_OPTIONS
        .iter()
        .map(|(mode, id, label)| {
            CheckMenuItem::with_id(
                app,
                *id,
                *label,
                true,
                *mode == settings.on_exit,
                None::<&str>,
            )
            .map(|item| (*mode, item))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let exit_items: Vec<&dyn IsMenuItem<R>> = on_exit.iter().map(|(_, i)| i as _).collect();
    let exit_menu = Submenu::with_items(app, "Al salir", true, &exit_items)?;

    let menu: Menu<R> = MenuBuilder::new(app)
        .item(&status)
        .separator()
        .text(OPEN, "Abrir")
        .text(INBOX, "Bandeja")
        .item(&projects)
        .separator()
        .item(&notifications)
        .item(&autostart)
        .item(&exit_menu)
        .text(LOG, "Ver log del server")
        .separator()
        .text(QUIT, "Salir")
        .build()?;

    let icon = TrayIconBuilder::with_id("main")
        .icon(self::icon(IconKind::Calm))
        .icon_as_template(true)
        .tooltip("control-plane")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)?;

    let tray = Tray {
        icon,
        status,
        projects,
        notifications,
        autostart,
        on_exit,
        // El builder ya puso el ícono tranquilo: no se vuelve a escribir.
        shown: Mutex::new(Shown {
            status: String::new(),
            icon: Some(IconKind::Calm),
            title: None,
            projects: None,
            project_items: Vec::new(),
        }),
    };
    tray.refresh(&Snapshot::default());
    app.manage(tray);
    Ok(())
}

impl<R: Runtime> Tray<R> {
    /// Refleja el estado del server. Solo toca lo que cambió (el server repite resúmenes).
    pub fn refresh(&self, snap: &Snapshot) {
        let mut shown = self.shown.lock().unwrap();
        let status = status_text(snap);
        if shown.status != status {
            let _ = self.status.set_text(&status);
            let _ = self
                .icon
                .set_tooltip(Some(format!("control-plane · {status}")));
            shown.status = status;
        }
        let kind = icon_kind(snap);
        if shown.icon != Some(kind) {
            // Cada cambio de ícono en Linux escribe un PNG temporal: solo cuando cambia.
            let _ = self.icon.set_icon(Some(icon(kind)));
            let _ = self.icon.set_icon_as_template(true);
            shown.icon = Some(kind);
        }
        let title = title_text(snap);
        if cfg!(target_os = "macos") && shown.title != title {
            let _ = self.icon.set_title(title.as_deref());
            shown.title = title;
        }
        let model = projects_model(snap);
        if shown.projects.as_ref() != Some(&model) {
            self.set_projects(&mut shown, &model);
            shown.projects = Some(model);
        }
    }

    /// Si solo cambiaron los conteos (mismos proyectos, mismo orden), cambia los textos en el
    /// lugar: así no parpadea ni se cierra el submenú abierto. Si no, lo rearma.
    fn set_projects(&self, shown: &mut Shown<R>, model: &ProjectsModel) {
        if let (Some(ProjectsModel::List(prev)), ProjectsModel::List(next)) =
            (&shown.projects, model)
        {
            let same_ids = prev.len() == next.len()
                && prev.iter().zip(next).all(|((a, _), (b, _))| a == b)
                && shown.project_items.len() == next.len();
            if same_ids {
                for (((_, old), (_, label)), item) in
                    prev.iter().zip(next).zip(&shown.project_items)
                {
                    if old != label {
                        let _ = item.set_text(label);
                    }
                }
                return;
            }
        }
        if let Ok(items) = self.projects.items() {
            for item in items {
                let _ = self.projects.remove(&item);
            }
        }
        shown.project_items.clear();
        let app = self.projects.app_handle();
        let item = match model {
            ProjectsModel::Offline => MenuItem::new(app, "Sin conexión", false, None::<&str>),
            ProjectsModel::Empty => {
                MenuItem::new(app, "Todavía no hay proyectos", false, None::<&str>)
            }
            ProjectsModel::List(list) => {
                for (id, label) in list {
                    let id = format!("{PROJECT_PREFIX}{id}");
                    if let Ok(item) = MenuItem::with_id(app, id, label, true, None::<&str>) {
                        let _ = self.projects.append(&item);
                        shown.project_items.push(item);
                    }
                }
                return;
            }
        };
        if let Ok(item) = item {
            let _ = self.projects.append(&item);
        }
    }

    fn sync_toggles(&self, app: &AppHandle<R>) {
        let settings = app.state::<AppState>().settings();
        let _ = self.notifications.set_checked(settings.notifications);
        for (mode, item) in &self.on_exit {
            let _ = item.set_checked(*mode == settings.on_exit);
        }
        let _ = self
            .autostart
            .set_checked(app.autolaunch().is_enabled().unwrap_or(false));
    }
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match action(event.id().as_ref()) {
        Action::Open => window::show_main(app),
        Action::Inbox => {
            window::show_main(app);
            if let Some(w) = app.get_webview_window(window::MAIN) {
                let _ = w.eval("window.__cpDesktop?.inbox()");
            }
        }
        Action::Project(id) => {
            window::open_route(app, &project_route(&id));
        }
        Action::ToggleNotifications => {
            app.state::<AppState>()
                .update_settings(|s| s.notifications = !s.notifications);
        }
        Action::OnExit(mode) => {
            app.state::<AppState>()
                .update_settings(|s| s.on_exit = mode);
        }
        Action::ToggleAutostart => {
            let auto = app.autolaunch();
            let res = if auto.is_enabled().unwrap_or(false) {
                auto.disable()
            } else {
                auto.enable()
            };
            if let Err(e) = res {
                eprintln!("No pude cambiar el inicio automático: {e}");
            }
        }
        Action::ShowLog => crate::sidecar::open_log(app),
        // El sidecar lo intercepta en RunEvent::ExitRequested y decide qué hacer con el server.
        Action::Quit => app.exit(0),
        Action::None => {}
    }
    // Los ítems con tilde se tildan solos al hacer clic: se dejan como dicen los ajustes.
    if let Some(tray) = app.try_state::<Tray<R>>() {
        tray.sync_toggles(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_ws::{ProjectSummary, Summary};

    fn snap(needs: u32, working: u32, projects: Vec<ProjectSummary>) -> Snapshot {
        Snapshot {
            connected: true,
            summary: Some(Summary {
                needs,
                working,
                running: needs + working,
                projects,
            }),
        }
    }

    fn project(id: &str, name: &str, needs: u32) -> ProjectSummary {
        ProjectSummary {
            id: id.into(),
            name: name.into(),
            needs,
            working: 0,
        }
    }

    #[test]
    fn status_line() {
        assert_eq!(
            status_text(&snap(3, 2, vec![])),
            "3 te necesitan · 2 trabajando"
        );
        assert_eq!(status_text(&snap(1, 0, vec![])), "1 te necesita");
        assert_eq!(status_text(&snap(0, 1, vec![])), "1 trabajando");
        assert_eq!(status_text(&snap(0, 0, vec![])), "Todo tranquilo");
        assert_eq!(
            status_text(&Snapshot::default()),
            "Sin conexión con el server"
        );
        // Conectado pero sin el primer resumen todavía, o un resumen viejo sin conexión.
        let waiting = Snapshot {
            connected: true,
            summary: None,
        };
        assert_eq!(status_text(&waiting), "Sin conexión con el server");
        let stale = Snapshot {
            connected: false,
            ..snap(2, 0, vec![])
        };
        assert_eq!(status_text(&stale), "Sin conexión con el server");
    }

    #[test]
    fn icon_and_title_follow_needs() {
        assert_eq!(icon_kind(&snap(0, 4, vec![])), IconKind::Calm);
        assert_eq!(icon_kind(&snap(2, 0, vec![])), IconKind::Attention);
        assert_eq!(icon_kind(&Snapshot::default()), IconKind::Calm);
        assert_eq!(title_text(&snap(2, 0, vec![])).as_deref(), Some("2"));
        assert_eq!(title_text(&snap(0, 3, vec![])), None);
    }

    #[test]
    fn projects_menu_model() {
        assert_eq!(projects_model(&Snapshot::default()), ProjectsModel::Offline);
        assert_eq!(projects_model(&snap(0, 0, vec![])), ProjectsModel::Empty);
        assert_eq!(
            projects_model(&snap(
                2,
                0,
                vec![project("a", "Alfa", 2), project("b", "R&D", 0)]
            )),
            ProjectsModel::List(vec![
                ("a".into(), "Alfa (2)".into()),
                ("b".into(), "R&&D".into()),
            ])
        );
    }

    #[test]
    fn project_routes_escape_the_id() {
        assert_eq!(project_route("abc-123_x"), "/p/abc-123_x");
        assert_eq!(project_route("a/../b"), "/p/a%2F..%2Fb");
        assert_eq!(project_route("a b?c#d"), "/p/a%20b%3Fc%23d");
        assert_eq!(project_route("ñ"), "/p/%C3%B1");
        assert!(window::is_route(&project_route("//evil\n")));
    }

    #[test]
    fn menu_ids_map_to_actions() {
        assert_eq!(action("open"), Action::Open);
        assert_eq!(action("inbox"), Action::Inbox);
        assert_eq!(action("project:x:y"), Action::Project("x:y".into()));
        assert_eq!(action("exit:stop"), Action::OnExit(OnExit::Stop));
        assert_eq!(action("exit:leave"), Action::OnExit(OnExit::Leave));
        assert_eq!(action("exit:ask"), Action::OnExit(OnExit::Ask));
        assert_eq!(action("notifications"), Action::ToggleNotifications);
        assert_eq!(action("autostart"), Action::ToggleAutostart);
        assert_eq!(action("log"), Action::ShowLog);
        assert_eq!(action("quit"), Action::Quit);
        assert_eq!(action("otra"), Action::None);
    }
}
