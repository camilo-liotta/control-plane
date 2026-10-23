//! El estado de las tarjetas, puro: qué se muestra, cuándo vence y qué hay que hacer en pantalla.
//!
//! Cada operación devuelve los [`Effect`]s que la capa Win32 tiene que aplicar. El reloj entra por
//! parámetro (`Instant`), así que todo se prueba sin esperar. Los vencimientos se pausan mientras
//! el puntero está sobre alguna tarjeta y siguen con lo que les quedaba al salir.

use std::time::{Duration, Instant};

use crate::desktop_ws::Toast;
use crate::notify::group_key;

pub type CardId = u64;

/// A lo sumo tres tarjetas a la vez: al llegar una cuarta sale la más vieja.
pub const MAX_CARDS: usize = 3;

/// Un aviso común (info, éxito) vence rápido: se lee de un vistazo.
const TTL_INFO: Duration = Duration::from_secs(8);
/// Uno que apunta a una sesión o proyecto: un poco más, para llegar a tocarlo.
const TTL_TARGET: Duration = Duration::from_secs(10);
/// Advertencias, errores y avisos que piden abrir algo o hacer algo (los de la app misma).
const TTL_ACTION: Duration = Duration::from_secs(15);

/// Qué hacer en pantalla después de una operación.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Crear la ventana de la tarjeta.
    Open(CardId),
    /// Cambió el contenido de una tarjeta que ya está: volver a medir y pintar.
    Update(CardId),
    /// Destruir la ventana de la tarjeta (y su timer).
    Close(CardId),
    /// Programar el vencimiento de la tarjeta dentro de esta duración (reemplaza al anterior).
    Arm(CardId, Duration),
    /// Cancelar el vencimiento (pausa por el puntero encima).
    Disarm(CardId),
    /// Volver a acomodar todas las tarjetas (cambió su cantidad o su tamaño).
    Relayout,
    /// Se tocó la tarjeta: ejecutar lo que avisaba este toast.
    Invoke(Toast),
}

#[derive(Debug, Clone)]
pub struct Card {
    pub id: CardId,
    /// El grupo del toast: otro con la misma clave reemplaza a esta tarjeta.
    pub key: String,
    pub toast: Toast,
    /// Lo que le queda de vida cuando está pausada (con el timer corriendo no se usa).
    remaining: Duration,
    /// Cuándo vence; `None` si está pausada.
    deadline: Option<Instant>,
}

/// Cuánto vive una tarjeta: 8 s los avisos comunes, 10 s si apuntan a una sesión o proyecto, y
/// 15 s las advertencias, los errores, los que piden abrir algo y los de la app misma.
pub fn ttl(t: &Toast) -> Duration {
    if matches!(t.level.as_str(), "warn" | "error") || t.open.is_some() || t.local.is_some() {
        TTL_ACTION
    } else if t.session_id.is_some() || t.project_id.is_some() {
        TTL_TARGET
    } else {
        TTL_INFO
    }
}

#[derive(Debug, Default)]
pub struct Stack {
    /// De la más vieja a la más nueva (la última es la que queda en la esquina).
    cards: Vec<Card>,
    next_id: CardId,
    /// El puntero está sobre una tarjeta: ningún vencimiento corre.
    paused: bool,
}

impl Stack {
    pub fn cards(&self) -> &[Card] {
        &self.cards
    }

    /// Un toast nuevo, agrupado como en Linux (`notify::group_key`).
    pub fn show(&mut self, toast: Toast, now: Instant) -> Vec<Effect> {
        let key = group_key(&toast);
        self.show_keyed(toast, Some(key), now)
    }

    /// Con clave, reemplaza a la tarjeta del mismo grupo (mismo lugar, el vencimiento arranca de
    /// nuevo); sin clave, siempre suma una.
    pub fn show_keyed(&mut self, toast: Toast, key: Option<String>, now: Instant) -> Vec<Effect> {
        let life = ttl(&toast);
        let same = key
            .as_ref()
            .and_then(|k| self.cards.iter().position(|c| c.key == *k));
        if let Some(i) = same {
            let card = &mut self.cards[i];
            card.toast = toast;
            card.remaining = life;
            card.deadline = (!self.paused).then_some(now + life);
            let mut fx = vec![Effect::Update(card.id)];
            if card.deadline.is_some() {
                fx.push(Effect::Arm(card.id, life));
            }
            fx.push(Effect::Relayout);
            return fx;
        }
        let mut fx = Vec::new();
        if self.cards.len() >= MAX_CARDS {
            fx.push(Effect::Close(self.cards.remove(0).id));
        }
        self.next_id += 1;
        let id = self.next_id;
        fx.push(Effect::Open(id));
        let deadline = (!self.paused).then_some(now + life);
        if deadline.is_some() {
            fx.push(Effect::Arm(id, life));
        }
        fx.push(Effect::Relayout);
        self.cards.push(Card {
            id,
            key: key.unwrap_or_default(),
            toast,
            remaining: life,
            deadline,
        });
        fx
    }

    fn take(&mut self, id: CardId) -> Option<Card> {
        let i = self.cards.iter().position(|c| c.id == id)?;
        Some(self.cards.remove(i))
    }

    /// Venció el timer de una tarjeta. Una que ya no está (se cerró justo antes): nada.
    pub fn expire(&mut self, id: CardId) -> Vec<Effect> {
        self.dismiss(id)
    }

    /// Se cerró con la "x": solo esa tarjeta, sin invocar nada.
    pub fn dismiss(&mut self, id: CardId) -> Vec<Effect> {
        match self.take(id) {
            Some(_) => vec![Effect::Close(id), Effect::Relayout],
            None => Vec::new(),
        }
    }

    /// Se tocó la tarjeta: se cierra y se invoca su toast (una sola vez).
    pub fn click(&mut self, id: CardId) -> Vec<Effect> {
        match self.take(id) {
            Some(card) => vec![
                Effect::Close(id),
                Effect::Invoke(card.toast),
                Effect::Relayout,
            ],
            None => Vec::new(),
        }
    }

    /// El puntero entró a una tarjeta (`Some`) o salió de todas (`None`). Entrar pausa todos los
    /// vencimientos; salir los retoma con lo que les quedaba.
    pub fn hover(&mut self, over: Option<CardId>, now: Instant) -> Vec<Effect> {
        match over {
            Some(id) if !self.paused && self.cards.iter().any(|c| c.id == id) => {
                self.paused = true;
                self.cards
                    .iter_mut()
                    .map(|c| {
                        if let Some(deadline) = c.deadline.take() {
                            c.remaining = deadline.saturating_duration_since(now);
                        }
                        Effect::Disarm(c.id)
                    })
                    .collect()
            }
            None if self.paused => {
                self.paused = false;
                self.cards
                    .iter_mut()
                    .map(|c| {
                        c.deadline = Some(now + c.remaining);
                        Effect::Arm(c.id, c.remaining)
                    })
                    .collect()
            }
            // Ya pausado, una tarjeta que no existe, o salir sin haber entrado.
            _ => Vec::new(),
        }
    }

    /// Cierra todas (la ventana ganó el foco, o se tocó una tarjeta).
    pub fn clear(&mut self) -> Vec<Effect> {
        self.paused = false;
        self.cards.drain(..).map(|c| Effect::Close(c.id)).collect()
    }

    /// Cuándo vence esa tarjeta, o `None` si no existe o está pausada (su timer no corre).
    pub fn card_deadline(&self, id: CardId) -> Option<Instant> {
        self.cards.iter().find(|c| c.id == id)?.deadline
    }

    // Lo que sigue describe el contrato de espera (R12.3) y lo fija con pruebas; la capa Win32 no lo
    // consulta: cada tarjeta tiene su propio `SetTimer` y el sistema despierta al proceso recién a
    // la hora del que vence primero, sin sondeo ni hilo.

    /// El próximo vencimiento, o `None` si no hay ninguno corriendo (no hay nada que esperar).
    #[cfg(test)]
    pub fn next_deadline(&self) -> Option<Instant> {
        self.cards.iter().filter_map(|c| c.deadline).min()
    }

    /// Cuánto falta para el próximo vencimiento (cero si ya pasó). Nada que esperar: `None`.
    #[cfg(test)]
    pub fn wake_in(&self, now: Instant) -> Option<Duration> {
        self.next_deadline()
            .map(|d| d.saturating_duration_since(now))
    }

    /// Las tarjetas que ya vencieron a `now`, de la más vieja a la más nueva.
    #[cfg(test)]
    pub fn due(&self, now: Instant) -> Vec<CardId> {
        self.cards
            .iter()
            .filter(|c| c.deadline.is_some_and(|d| d <= now))
            .map(|c| c.id)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_ws::Toast;

    const S: Duration = Duration::from_secs(1);

    fn toast(session: Option<&str>, level: &str, title: &str) -> Toast {
        Toast {
            level: level.into(),
            title: title.into(),
            session_id: session.map(Into::into),
            ..Toast::default()
        }
    }

    fn ids(stack: &Stack) -> Vec<CardId> {
        stack.cards().iter().map(|c| c.id).collect()
    }

    fn id_of(effects: &[Effect]) -> CardId {
        effects
            .iter()
            .find_map(|e| match e {
                Effect::Open(id) => Some(*id),
                _ => None,
            })
            .expect("abre una tarjeta")
    }

    #[test]
    fn a_new_toast_opens_a_card_and_arms_its_timer() {
        let mut s = Stack::default();
        let now = Instant::now();
        let fx = s.show(toast(Some("a"), "info", "uno"), now);
        let id = id_of(&fx);
        assert_eq!(
            fx,
            vec![Effect::Open(id), Effect::Arm(id, 10 * S), Effect::Relayout]
        );
        assert_eq!(s.cards().len(), 1);
        assert_eq!(s.cards()[0].toast.title, "uno");
        assert_eq!(s.cards()[0].key, "session:a");
    }

    #[test]
    fn the_same_group_replaces_the_card_in_place_and_resets_its_timer() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "uno"), now));
        let b = id_of(&s.show(toast(Some("b"), "info", "dos"), now));
        let fx = s.show(toast(Some("a"), "warn", "uno nuevo"), now + 5 * S);
        assert_eq!(
            fx,
            vec![Effect::Update(a), Effect::Arm(a, 15 * S), Effect::Relayout]
        );
        // Mismo lugar y misma tarjeta; el otro no se movió.
        assert_eq!(ids(&s), vec![a, b]);
        assert_eq!(s.cards()[0].toast.title, "uno nuevo");
        assert_eq!(s.cards()[0].toast.level, "warn");
        assert_eq!(s.cards()[1].toast.title, "dos");
        assert_eq!(s.next_deadline(), Some(now + 10 * S));
    }

    #[test]
    fn without_a_key_every_toast_adds_a_card() {
        let mut s = Stack::default();
        let now = Instant::now();
        s.show_keyed(toast(None, "info", "uno"), None, now);
        s.show_keyed(toast(None, "info", "dos"), None, now);
        assert_eq!(s.cards().len(), 2);
        // Con la clave de grupo de siempre, dos sin sesión ni proyecto son el mismo grupo.
        let mut s = Stack::default();
        s.show(toast(None, "info", "uno"), now);
        s.show(toast(None, "info", "dos"), now);
        assert_eq!(s.cards().len(), 1);
        assert_eq!(s.cards()[0].toast.title, "dos");
    }

    #[test]
    fn a_fourth_card_evicts_the_oldest_but_a_replacement_does_not() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        let b = id_of(&s.show(toast(Some("b"), "info", "b"), now));
        let c = id_of(&s.show(toast(Some("c"), "info", "c"), now));
        // Reemplazar con tres tarjetas no expulsa a nadie.
        let fx = s.show(toast(Some("b"), "info", "b2"), now);
        assert!(!fx.iter().any(|e| matches!(e, Effect::Close(_))));
        assert_eq!(ids(&s), vec![a, b, c]);
        // La cuarta, de otro grupo: sale la más vieja, la nueva queda más cerca de la esquina.
        let fx = s.show(toast(Some("d"), "info", "d"), now);
        let d = id_of(&fx);
        assert_eq!(
            fx,
            vec![
                Effect::Close(a),
                Effect::Open(d),
                Effect::Arm(d, 10 * S),
                Effect::Relayout
            ]
        );
        assert_eq!(ids(&s), vec![b, c, d]);
    }

    #[test]
    fn ids_are_never_reused() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        s.dismiss(a);
        let b = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        assert_ne!(a, b);
    }

    #[test]
    fn a_click_closes_the_card_and_invokes_its_toast() {
        let mut s = Stack::default();
        let now = Instant::now();
        let t = toast(Some("a"), "info", "uno");
        let a = id_of(&s.show(t.clone(), now));
        let fx = s.click(a);
        assert_eq!(
            fx,
            vec![Effect::Close(a), Effect::Invoke(t), Effect::Relayout]
        );
        assert!(s.cards().is_empty());
        // Un segundo clic (la tarjeta ya no está) no invoca nada otra vez.
        assert!(s.click(a).is_empty());
    }

    #[test]
    fn dismiss_and_expire_close_without_invoking() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        let b = id_of(&s.show(toast(Some("b"), "info", "b"), now));
        let c = id_of(&s.show(toast(Some("c"), "info", "c"), now));
        assert_eq!(s.dismiss(a), vec![Effect::Close(a), Effect::Relayout]);
        assert_eq!(s.expire(b), vec![Effect::Close(b), Effect::Relayout]);
        assert_eq!(ids(&s), vec![c]);
        // Ids que no existen: nada pasa.
        assert!(s.expire(a).is_empty());
        assert!(s.dismiss(999).is_empty());
        assert_eq!(ids(&s), vec![c]);
    }

    #[test]
    fn closing_one_card_leaves_the_other_timers_alone() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        s.show(toast(Some("b"), "warn", "b"), now + 2 * S);
        assert_eq!(s.next_deadline(), Some(now + 10 * S));
        s.dismiss(a);
        assert_eq!(s.next_deadline(), Some(now + 2 * S + 15 * S));
    }

    #[test]
    fn hovering_pauses_every_timer_and_leaving_resumes_with_what_was_left() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        let b = id_of(&s.show(toast(Some("b"), "warn", "b"), now + S));
        // A los 3 s: a lleva 3 de 8 y b lleva 2 de 15.
        let fx = s.hover(Some(a), now + 3 * S);
        assert_eq!(fx, vec![Effect::Disarm(a), Effect::Disarm(b)]);
        assert_eq!(s.next_deadline(), None);
        // Moverse sobre la otra tarjeta, ya pausado, no cambia nada.
        assert!(s.hover(Some(b), now + 4 * S).is_empty());
        // Se suelta a los 20 s: retoman con lo que les quedaba.
        let fx = s.hover(None, now + 20 * S);
        assert_eq!(fx, vec![Effect::Arm(a, 7 * S), Effect::Arm(b, 13 * S)]);
        assert_eq!(s.next_deadline(), Some(now + 27 * S));
        // Soltar sin haber pausado: nada.
        assert!(s.hover(None, now + 21 * S).is_empty());
    }

    #[test]
    fn a_card_that_arrives_while_hovering_waits_for_the_pointer_to_leave() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        s.hover(Some(a), now);
        let fx = s.show(toast(Some("b"), "info", "b"), now + S);
        let b = id_of(&fx);
        assert_eq!(fx, vec![Effect::Open(b), Effect::Relayout]);
        assert_eq!(s.next_deadline(), None);
        let fx = s.hover(None, now + 2 * S);
        assert_eq!(fx, vec![Effect::Arm(a, 10 * S), Effect::Arm(b, 10 * S)]);
    }

    #[test]
    fn hovering_an_unknown_card_does_nothing() {
        let mut s = Stack::default();
        let now = Instant::now();
        s.show(toast(Some("a"), "info", "a"), now);
        assert!(s.hover(Some(999), now).is_empty());
        // El timer sigue corriendo: no se pausó nada.
        assert_eq!(s.next_deadline(), Some(now + 10 * S));
    }

    #[test]
    fn clear_closes_everything_and_leaves_nothing_scheduled() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        let b = id_of(&s.show(toast(Some("b"), "info", "b"), now));
        s.hover(Some(a), now);
        assert_eq!(s.clear(), vec![Effect::Close(a), Effect::Close(b)]);
        assert!(s.cards().is_empty());
        assert_eq!(s.next_deadline(), None);
        assert!(s.clear().is_empty());
        // Lo que viene después arranca limpio (sin el hover de antes).
        s.show(toast(Some("c"), "info", "c"), now);
        assert_eq!(s.next_deadline(), Some(now + 10 * S));
    }

    #[test]
    fn ttl_depends_on_how_much_the_toast_asks_of_the_user() {
        let mut t = toast(None, "info", "x");
        assert_eq!(ttl(&t), 8 * S);
        t.level = "success".into();
        assert_eq!(ttl(&t), 8 * S);
        // Apunta a una sesión: un poco más para llegar a tocarlo.
        t.session_id = Some("s".into());
        assert_eq!(ttl(&t), 10 * S);
        // Pide abrir algo (la compactación), o es una advertencia o un error: 15 s o más.
        t.open = Some("compaction".into());
        assert_eq!(ttl(&t), 15 * S);
        assert_eq!(ttl(&toast(None, "warn", "x")), 15 * S);
        assert_eq!(ttl(&toast(None, "error", "x")), 15 * S);
        let mut local = toast(None, "info", "x");
        local.local = Some(crate::desktop_ws::Local::Update);
        assert_eq!(ttl(&local), 15 * S);
    }

    #[test]
    fn a_card_knows_its_own_deadline_only_while_its_timer_runs() {
        let mut s = Stack::default();
        let now = Instant::now();
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        let b = id_of(&s.show(toast(Some("b"), "warn", "b"), now));
        assert_eq!(s.card_deadline(a), Some(now + 10 * S));
        assert_eq!(s.card_deadline(b), Some(now + 15 * S));
        assert_eq!(s.card_deadline(999), None);
        // Pausada: no hay vencimiento, y un aviso de timer que quedó en la cola no la cierra.
        s.hover(Some(a), now + S);
        assert_eq!(s.card_deadline(a), None);
        assert_eq!(s.card_deadline(b), None);
    }

    #[test]
    fn the_scheduler_sleeps_until_the_next_deadline_and_not_at_all_when_empty() {
        let mut s = Stack::default();
        let now = Instant::now();
        assert_eq!(s.next_deadline(), None);
        assert_eq!(s.wake_in(now), None);
        assert!(s.due(now + 100 * S).is_empty());
        let a = id_of(&s.show(toast(Some("a"), "info", "a"), now));
        let b = id_of(&s.show(toast(Some("b"), "warn", "b"), now));
        assert_eq!(s.next_deadline(), Some(now + 10 * S));
        assert_eq!(s.wake_in(now + 3 * S), Some(7 * S));
        // Pasado el vencimiento, ya toca (no queda tiempo de espera).
        assert_eq!(s.wake_in(now + 11 * S), Some(Duration::ZERO));
        // Ninguna se despierta antes de su hora.
        assert!(s.due(now + 10 * S - Duration::from_millis(1)).is_empty());
        assert_eq!(s.due(now + 10 * S), vec![a]);
        assert_eq!(s.due(now + 15 * S), vec![a, b]);
    }
}
