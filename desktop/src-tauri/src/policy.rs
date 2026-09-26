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
        Action::ShowLog | Action::GetNode => true,
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
    /// Mostrar el diálogo y volver a decidir con la respuesta.
    Ask,
    /// No salir.
    Stay,
}

/// La salida: un server ajeno nunca se toca; uno propio según "Al salir" o la respuesta.
/// Si el sistema se está apagando o cerrando la sesión, no se pregunta (el sistema ya le manda
/// SIGTERM al server, que se cierra ordenado).
pub fn exit_action(
    kind: ServerKind,
    on_exit: OnExit,
    answer: Option<Answer>,
    system_ending: bool,
) -> ExitAction {
    if kind != ServerKind::Own || system_ending {
        return ExitAction::Exit;
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

/// El texto del diálogo de salida, con las sesiones que corta detener el server.
pub fn exit_question(running: Option<u32>) -> String {
    match running {
        Some(0) => "No hay sesiones abiertas. ¿Detenés el server o lo dejás corriendo?".into(),
        Some(1) => "Hay 1 sesión abierta: detener el server la cierra (se reanuda después).".into(),
        Some(n) => format!(
            "Hay {n} sesiones abiertas: detener el server las cierra (se reanudan después)."
        ),
        None => "Detener el server cierra las sesiones abiertas (se reanudan después).".into(),
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
        use ServerKind::{Foreign, None as NoServer, Own};
        for on_exit in [OnExit::Ask, OnExit::Stop, OnExit::Leave] {
            for answer in [None, Some(Stop), Some(Leave), Some(Cancel)] {
                // Ajeno o sin server: salir sin tocar nada, diga lo que diga.
                assert_eq!(exit_action(Foreign, on_exit, answer, false), Exit);
                assert_eq!(exit_action(NoServer, on_exit, answer, false), Exit);
                // Apagado o cierre de sesión: nunca se pregunta.
                assert_eq!(exit_action(Own, on_exit, answer, true), Exit);
            }
        }
        assert_eq!(exit_action(Own, OnExit::Ask, None, false), Ask);
        assert_eq!(exit_action(Own, OnExit::Stop, None, false), StopThenExit);
        assert_eq!(exit_action(Own, OnExit::Leave, None, false), Exit);
        assert_eq!(
            exit_action(Own, OnExit::Ask, Some(Stop), false),
            StopThenExit
        );
        assert_eq!(exit_action(Own, OnExit::Ask, Some(Leave), false), Exit);
        assert_eq!(exit_action(Own, OnExit::Ask, Some(Cancel), false), Stay);
    }

    #[test]
    fn only_idle_accepts_actions_that_launch() {
        use Action::*;
        for a in [
            Retry, Launch, PickNode, OpenAnyway, Cancel, SetPort, UseThat,
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
        }
    }

    #[test]
    fn exit_question_counts_sessions() {
        assert!(exit_question(Some(3)).starts_with("Hay 3 sesiones abiertas"));
        assert!(exit_question(Some(1)).starts_with("Hay 1 sesión abierta"));
        assert!(exit_question(Some(0)).starts_with("No hay sesiones"));
        assert!(exit_question(None).starts_with("Detener el server"));
    }
}
