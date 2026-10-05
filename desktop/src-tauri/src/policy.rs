//! Las decisiones del sidecar que no dependen de Tauri: cuándo relanzar y qué hacer al salir.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::screen::Action;
use crate::settings::OnExit;

/// En qué está el sidecar, para saber qué botones valen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    /// Mostrando una pantalla, esperando un botón.
    Idle,
    /// Lanzó el server y espera que responda.
    Starting,
    /// Hay un server (propio o ajeno) en la ventana.
    Running,
}

/// ¿Vale este botón ahora? Un pedido repetido (doble clic, una pantalla vieja en el historial)
/// no puede lanzar un segundo server ni soltar el que está corriendo.
pub fn action_allowed(busy: Busy, action: Action) -> bool {
    match action {
        Action::ShowLog | Action::GetNode | Action::GetClaude => true,
        Action::Wait | Action::Stop => busy == Busy::Starting,
        _ => busy == Busy::Idle,
    }
}

/// Si vivió menos que esto, que se caiga de nuevo es lo más probable: no se relanza solo.
pub const MIN_UPTIME: Duration = Duration::from_secs(60);
pub const WINDOW: Duration = Duration::from_secs(5 * 60);
pub const MAX_RESTARTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restart {
    Relaunch,
    /// Vivió muy poco: se muestra el error con el log.
    TooSoon,
    /// Ya se relanzó `MAX_RESTARTS` veces en los últimos 5 minutos.
    TooMany,
}

/// Relanzamientos del server propio. Cada caída se avisa siempre; relanzar, solo a veces.
#[derive(Debug, Default)]
pub struct RestartPolicy {
    history: VecDeque<Instant>,
}

impl RestartPolicy {
    pub fn decide(&mut self, uptime: Duration, now: Instant) -> Restart {
        while self
            .history
            .front()
            .is_some_and(|t| now.duration_since(*t) > WINDOW)
        {
            self.history.pop_front();
        }
        if uptime < MIN_UPTIME {
            return Restart::TooSoon;
        }
        if self.history.len() >= MAX_RESTARTS {
            return Restart::TooMany;
        }
        self.history.push_back(now);
        Restart::Relaunch
    }
}

/// De quién es el server al momento de salir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerKind {
    /// No hay server (o no se llegó a lanzar).
    None,
    Foreign,
    Own,
}

/// Lo que eligió el usuario en el diálogo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Stop,
    Leave,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitAction {
    /// Salir sin tocar el server.
    Exit,
    StopThenExit,
    /// Para actualizar: el server guarda las sesiones activas para retomarlas, se detiene y la
    /// app sale. La app nueva lanza el server nuevo, que las retoma.
    RestartThenExit,
    /// Mostrar el diálogo y volver a decidir con la respuesta.
    Ask,
    /// No salir.
    Stay,
}

/// Cómo se pidió salir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QuitMode {
    /// "Salir", o `--quit` a secas: según "Al salir".
    #[default]
    Normal,
    /// `--quit --keep-server`: salir dejando el server (lo usaban los instaladores anteriores).
    KeepServer,
    /// `--quit --restart-for-update`: lo usan `get.sh` e `install.sh` después de instalar.
    RestartForUpdate,
}

/// La salida: un server ajeno nunca se toca; uno propio según "Al salir" o la respuesta.
/// Si el sistema se está apagando o cerrando la sesión, no se pregunta (el sistema ya le manda
/// SIGTERM al server, que se cierra ordenado). Los pedidos explícitos (`--keep-server`,
/// `--restart-for-update`) no preguntan, diga lo que diga "Al salir", y no cambian el ajuste.
pub fn exit_action(
    kind: ServerKind,
    on_exit: OnExit,
    answer: Option<Answer>,
    system_ending: bool,
    mode: QuitMode,
) -> ExitAction {
    if kind != ServerKind::Own || system_ending {
        return ExitAction::Exit;
    }
    match mode {
        QuitMode::KeepServer => return ExitAction::Exit,
        QuitMode::RestartForUpdate => return ExitAction::RestartThenExit,
        QuitMode::Normal => {}
    }
    let choice = match (on_exit, answer) {
        (_, Some(a)) => a,
        (OnExit::Stop, None) => Answer::Stop,
        (OnExit::Leave, None) => Answer::Leave,
        (OnExit::Ask, None) => return ExitAction::Ask,
    };
    match choice {
        Answer::Stop => ExitAction::StopThenExit,
        Answer::Leave => ExitAction::Exit,
        Answer::Cancel => ExitAction::Stay,
    }
}

/// Al tocar "Actualizar a…": directo si no hay sesiones trabajando; si hay, se pregunta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStart {
    Now,
    Ask { working: u32 },
}

pub fn update_start(working: u32) -> UpdateStart {
    if working == 0 {
        UpdateStart::Now
    } else {
        UpdateStart::Ask { working }
    }
}

pub fn update_question(working: u32) -> String {
    let n = if working == 1 {
        "1 sesión está trabajando".to_string()
    } else {
        format!("{working} sesiones están trabajando")
    };
    format!("{n}. Actualizar reinicia el server: al volver, las sesiones se retoman solas y las que estaban trabajando siguen desde donde se cortó su turno.")
}

/// Cuánto se espera, con "Esperar a que terminen", antes de actualizar igual.
pub const WAIT_FOR_IDLE: Duration = Duration::from_secs(30 * 60);

/// Un server adoptado, según su versión y la de la app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerAge {
    /// La misma (o una que no se entiende: no se molesta).
    Current,
    /// Propio y más viejo: se reinicia solo si no hay sesiones trabajando; si hay, se ofrece.
    OlderOwn {
        from: String,
        to: String,
        auto: bool,
    },
    /// Ajeno (un `npm start`) y más viejo: solo se avisa.
    OlderForeign { from: String, to: String },
}

pub fn server_age(app: &str, server: &str, kind: ServerKind, working: u32) -> ServerAge {
    use crate::update::Version;
    let (Some(a), Some(s)) = (Version::parse(app), Version::parse(server)) else {
        return ServerAge::Current;
    };
    if s >= a {
        return ServerAge::Current;
    }
    let (from, to) = (s.to_string(), a.to_string());
    match kind {
        ServerKind::Own => ServerAge::OlderOwn {
            from,
            to,
            auto: working == 0,
        },
        ServerKind::Foreign => ServerAge::OlderForeign { from, to },
        ServerKind::None => ServerAge::Current,
    }
}

/// El texto del diálogo de salida: cuántas sesiones corta detener el server, separando las que
/// están trabajando (cortan su turno) de las quietas. `running` son las que tienen el proceso
/// vivo; `working`, las que están trabajando o arrancando (son parte de `running`).
pub fn exit_question(running: Option<u32>, working: Option<u32>) -> String {
    const AFTER_ONE: &str =
        "Queda detenida, con su conversación, y vuelve a arrancar cuando le escribas.";
    const AFTER_MANY: &str =
        "Quedan detenidas, con su conversación, y vuelven a arrancar cuando les escribas.";
    let Some(running) = running else {
        return format!("Detener el server cierra las sesiones abiertas. {AFTER_MANY}");
    };
    let working = working.unwrap_or(0).min(running);
    let quiet = running - working;
    let sessions = |n: u32| {
        if n == 1 {
            "1 sesión".to_string()
        } else {
            format!("{n} sesiones")
        }
    };
    let after = if running == 1 { AFTER_ONE } else { AFTER_MANY };
    match (working, quiet) {
        (0, 0) => "No hay sesiones abiertas. ¿Detenés el server o lo dejás corriendo?".into(),
        (0, q) => format!(
            "Hay {} abierta{}, ninguna trabajando: detener el server {}. {after}",
            sessions(q),
            if q == 1 { "" } else { "s" },
            if q == 1 { "la cierra" } else { "las cierra" },
        ),
        (w, q) => {
            let quiet = match q {
                0 => String::new(),
                1 => " y 1 quieta".into(),
                q => format!(" y {q} quietas"),
            };
            let cut = if w == 1 {
                "la que trabaja corta su turno a la mitad"
            } else {
                "las que trabajan cortan su turno a la mitad"
            };
            format!(
                "Hay {} trabajando{quiet}. Detener el server {}: {cut}. {after} Si lo dejás corriendo, {} trabajando aunque cierres la app.",
                sessions(w),
                if running == 1 { "la cierra" } else { "las cierra" },
                if w == 1 { "sigue" } else { "siguen" },
            )
        }
    }
}

/// "Recordar mi elección": la respuesta pasa a ser el ajuste "Al salir" (el mismo del menú del
/// ícono). Cancelar no se recuerda.
pub fn remembered(answer: Answer) -> Option<OnExit> {
    match answer {
        Answer::Stop => Some(OnExit::Stop),
        Answer::Leave => Some(OnExit::Leave),
        Answer::Cancel => None,
    }
}

/// Qué hace cerrar la ventana.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Close {
    /// Esconderla: la app sigue en el ícono de la barra.
    Hide,
    /// No hay ícono visible (GNOME sin extensión de bandeja): sin él no habría cómo volver a la
    /// ventana ni cómo salir, así que cerrar la ventana es salir (con la decisión de "Al salir").
    Quit,
}

pub fn close_action(tray_visible: bool) -> Close {
    if tray_visible {
        Close::Hide
    } else {
        Close::Quit
    }
}

/// Va antes de la pregunta de salida cuando se cerró la ventana sin un ícono visible.
pub const NO_TRAY_NOTE: &str = "No se ve el ícono de control-plane en la barra de arriba (en GNOME hace falta una extensión, como AppIndicator): cerrar la ventana cierra la app.";

/// El aviso de la primera vez que se esconde la ventana: dónde quedó la app y cómo volver.
pub fn close_hint(mac: bool) -> &'static str {
    if mac {
        "La ventana se cerró, pero el server y las sesiones siguen. Para volver, tocá el ícono de control-plane en la barra de menú → Abrir, o el ícono del Dock. Para salir del todo: el mismo ícono → Salir."
    } else {
        "La ventana se cerró, pero el server y las sesiones siguen. Para volver, tocá el ícono de control-plane en la barra de arriba → Abrir, o abrila de nuevo desde las aplicaciones. Para salir del todo: el mismo ícono → Salir."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_needs_uptime_and_respects_the_cap() {
        let mut p = RestartPolicy::default();
        let t0 = Instant::now();
        let min = Duration::from_secs(61);
        assert_eq!(p.decide(Duration::from_secs(5), t0), Restart::TooSoon);
        assert_eq!(p.decide(min, t0), Restart::Relaunch);
        assert_eq!(
            p.decide(min, t0 + Duration::from_secs(70)),
            Restart::Relaunch
        );
        assert_eq!(
            p.decide(min, t0 + Duration::from_secs(140)),
            Restart::Relaunch
        );
        assert_eq!(
            p.decide(min, t0 + Duration::from_secs(210)),
            Restart::TooMany
        );
        // Pasados 5 minutos del primero, se libera un lugar.
        assert_eq!(
            p.decide(min, t0 + Duration::from_secs(301)),
            Restart::Relaunch
        );
        assert_eq!(
            p.decide(min, t0 + Duration::from_secs(302)),
            Restart::TooMany
        );
    }

    #[test]
    fn a_too_soon_crash_does_not_count() {
        let mut p = RestartPolicy::default();
        let t0 = Instant::now();
        for i in 0..5 {
            assert_eq!(
                p.decide(Duration::from_secs(1), t0 + Duration::from_secs(i)),
                Restart::TooSoon
            );
        }
        assert_eq!(
            p.decide(Duration::from_secs(90), t0 + Duration::from_secs(10)),
            Restart::Relaunch
        );
    }

    #[test]
    fn exit_table() {
        use Answer::*;
        use ExitAction::*;
        use QuitMode::{KeepServer, Normal, RestartForUpdate};
        use ServerKind::{Foreign, None as NoServer, Own};
        for on_exit in [OnExit::Ask, OnExit::Stop, OnExit::Leave] {
            for answer in [None, Some(Stop), Some(Leave), Some(Cancel)] {
                for mode in [Normal, KeepServer, RestartForUpdate] {
                    // Ajeno o sin server: salir sin tocar nada, diga lo que diga.
                    assert_eq!(exit_action(Foreign, on_exit, answer, false, mode), Exit);
                    assert_eq!(exit_action(NoServer, on_exit, answer, false, mode), Exit);
                    // Apagado o cierre de sesión: nunca se pregunta.
                    assert_eq!(exit_action(Own, on_exit, answer, true, mode), Exit);
                }
                // --quit --keep-server: sale dejando el server, sin preguntar ni detenerlo.
                assert_eq!(exit_action(Own, on_exit, answer, false, KeepServer), Exit);
                // --quit --restart-for-update: guarda las sesiones, lo detiene y sale, sin preguntar.
                assert_eq!(
                    exit_action(Own, on_exit, answer, false, RestartForUpdate),
                    RestartThenExit
                );
            }
        }
        // Un --quit a secas (o "Salir") sigue respetando "Al salir".
        assert_eq!(exit_action(Own, OnExit::Ask, None, false, Normal), Ask);
        assert_eq!(
            exit_action(Own, OnExit::Stop, None, false, Normal),
            StopThenExit
        );
        assert_eq!(exit_action(Own, OnExit::Leave, None, false, Normal), Exit);
        assert_eq!(
            exit_action(Own, OnExit::Ask, Some(Stop), false, Normal),
            StopThenExit
        );
        assert_eq!(
            exit_action(Own, OnExit::Ask, Some(Leave), false, Normal),
            Exit
        );
        assert_eq!(
            exit_action(Own, OnExit::Ask, Some(Cancel), false, Normal),
            Stay
        );
    }

    #[test]
    fn update_asks_only_with_sessions_working() {
        assert_eq!(update_start(0), UpdateStart::Now);
        assert_eq!(update_start(2), UpdateStart::Ask { working: 2 });
        assert!(update_question(1).starts_with("1 sesión está trabajando."));
        assert!(update_question(3).starts_with("3 sesiones están trabajando."));
    }

    #[test]
    fn older_servers() {
        use ServerKind::*;
        assert_eq!(server_age("0.3.2", "0.3.2", Own, 0), ServerAge::Current);
        assert_eq!(
            server_age("0.3.2", "0.4.0", Own, 0),
            ServerAge::Current,
            "más nuevo: no se toca"
        );
        assert_eq!(
            server_age("0.3.2", "dev", Own, 0),
            ServerAge::Current,
            "no se entiende: no se molesta"
        );
        assert_eq!(
            server_age("0.3.2", "0.1.0", Own, 0),
            ServerAge::OlderOwn {
                from: "0.1.0".into(),
                to: "0.3.2".into(),
                auto: true
            }
        );
        assert_eq!(
            server_age("0.3.2", "0.3.1", Own, 2),
            ServerAge::OlderOwn {
                from: "0.3.1".into(),
                to: "0.3.2".into(),
                auto: false
            }
        );
        assert_eq!(
            server_age("0.3.2", "0.1.0", Foreign, 0),
            ServerAge::OlderForeign {
                from: "0.1.0".into(),
                to: "0.3.2".into()
            }
        );
        assert_eq!(
            server_age("0.10.0", "0.9.9", Own, 1),
            ServerAge::OlderOwn {
                from: "0.9.9".into(),
                to: "0.10.0".into(),
                auto: false
            }
        );
    }

    #[test]
    fn only_idle_accepts_actions_that_launch() {
        use Action::*;
        for a in [
            Retry, Launch, PickNode, PickClaude, OpenAnyway, Cancel, SetPort, UseThat,
        ] {
            assert!(action_allowed(Busy::Idle, a), "{a:?}");
            assert!(!action_allowed(Busy::Starting, a), "{a:?}");
            assert!(!action_allowed(Busy::Running, a), "{a:?}");
        }
        for a in [Wait, Stop] {
            assert!(action_allowed(Busy::Starting, a));
            assert!(!action_allowed(Busy::Idle, a) && !action_allowed(Busy::Running, a));
        }
        for busy in [Busy::Idle, Busy::Starting, Busy::Running] {
            assert!(action_allowed(busy, ShowLog) && action_allowed(busy, GetNode));
            assert!(action_allowed(busy, GetClaude));
        }
    }

    #[test]
    fn exit_question_separates_working_from_quiet() {
        assert_eq!(
            exit_question(Some(0), Some(0)),
            "No hay sesiones abiertas. ¿Detenés el server o lo dejás corriendo?"
        );
        assert_eq!(
            exit_question(Some(3), Some(0)),
            "Hay 3 sesiones abiertas, ninguna trabajando: detener el server las cierra. Quedan detenidas, con su conversación, y vuelven a arrancar cuando les escribas."
        );
        assert_eq!(
            exit_question(Some(1), None),
            "Hay 1 sesión abierta, ninguna trabajando: detener el server la cierra. Queda detenida, con su conversación, y vuelve a arrancar cuando le escribas."
        );
        assert_eq!(
            exit_question(Some(3), Some(2)),
            "Hay 2 sesiones trabajando y 1 quieta. Detener el server las cierra: las que trabajan cortan su turno a la mitad. Quedan detenidas, con su conversación, y vuelven a arrancar cuando les escribas. Si lo dejás corriendo, siguen trabajando aunque cierres la app."
        );
        assert_eq!(
            exit_question(Some(1), Some(1)),
            "Hay 1 sesión trabajando. Detener el server la cierra: la que trabaja corta su turno a la mitad. Queda detenida, con su conversación, y vuelve a arrancar cuando le escribas. Si lo dejás corriendo, sigue trabajando aunque cierres la app."
        );
        assert!(exit_question(Some(5), Some(1)).starts_with("Hay 1 sesión trabajando y 4 quietas."));
        // Un resumen desparejo (más trabajando que abiertas) no da números negativos.
        assert!(exit_question(Some(1), Some(3)).starts_with("Hay 1 sesión trabajando."));
        assert!(exit_question(None, Some(2)).starts_with("Detener el server cierra"));
    }

    #[test]
    fn remember_sets_on_exit_and_cancel_is_not_remembered() {
        assert_eq!(remembered(Answer::Stop), Some(OnExit::Stop));
        assert_eq!(remembered(Answer::Leave), Some(OnExit::Leave));
        assert_eq!(remembered(Answer::Cancel), None);
    }

    #[test]
    fn closing_without_a_visible_icon_quits() {
        assert_eq!(close_action(true), Close::Hide);
        assert_eq!(close_action(false), Close::Quit);
        assert!(close_hint(true).contains("barra de menú"));
        assert!(close_hint(false).contains("barra de arriba"));
    }
}
