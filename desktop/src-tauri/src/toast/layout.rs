//! La geometría y los colores de las tarjetas, puros: dónde va cada una, cómo se recorta el texto
//! y de qué color se pinta. Todo en píxeles físicos; lo que viene "en DIP" se escala por `dpi / 96`.

/// Ancho de la tarjeta, en DIP.
pub const CARD_WIDTH_DIP: i32 = 360;
/// Alto mínimo (título de una línea y un cuerpo corto), en DIP.
pub const CARD_MIN_HEIGHT_DIP: i32 = 76;
/// Distancia al borde del área de trabajo.
pub const MARGIN_DIP: i32 = 12;
/// Hueco entre tarjetas.
pub const GAP_DIP: i32 = 8;
/// El botón de cerrar: un cuadrado en la esquina de arriba a la derecha.
pub const CLOSE_SIZE_DIP: i32 = 24;
pub const CLOSE_INSET_DIP: i32 = 6;
/// Máximo de líneas del título y del cuerpo.
pub const TITLE_MAX_LINES: u32 = 2;
pub const BODY_MAX_LINES: u32 = 3;
/// Máximo de caracteres que se miden y se dibujan (lo que sobra no se ve de todos modos).
pub const TITLE_MAX_CHARS: usize = 160;
pub const BODY_MAX_CHARS: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

/// De DIP a píxeles con el DPI del monitor (96 = 100 %), redondeando al más cercano.
pub fn dip(v: i32, dpi: u32) -> i32 {
    ((i64::from(v) * i64::from(dpi) + 48) / 96) as i32
}

/// El ancho de la tarjeta: el de siempre, salvo en un área de trabajo más angosta.
pub fn card_width(work: Rect, dpi: u32) -> i32 {
    dip(CARD_WIDTH_DIP, dpi).min((work.width() - 2 * dip(MARGIN_DIP, dpi)).max(1))
}

/// Dónde va cada tarjeta, en la esquina de abajo a la derecha del área de trabajo (la barra de
/// tareas ya quedó afuera, esté donde esté). `heights_px` va de la más vieja a la más nueva: la
/// última queda contra la esquina y las otras se apilan hacia arriba. Si no entran en la pantalla
/// (200-300 % en una pantalla baja), las de arriba se pisan un poco, pero ninguna se sale.
pub fn place(work: Rect, dpi: u32, heights_px: &[i32]) -> Vec<Rect> {
    let margin = dip(MARGIN_DIP, dpi);
    let gap = dip(GAP_DIP, dpi);
    let width = card_width(work, dpi);
    let right = work.right - margin;
    let mut bottom = work.bottom - margin;
    let mut out: Vec<Rect> = heights_px
        .iter()
        .rev()
        .map(|&h| {
            let h = h.min(work.height()).max(1);
            let top = (bottom - h).max(work.top);
            let r = Rect::new(right - width, top, right, top + h);
            bottom = r.top - gap;
            r
        })
        .collect();
    out.reverse();
    out
}

/// Recorta `text` para que ocupe a lo sumo `max_lines` líneas, con "…" al final si tuvo que cortar.
/// `lines` mide cuántas líneas ocupa un texto con la fuente real (acá, un medidor cualquiera).
pub fn fit(text: &str, max_lines: u32, lines: impl Fn(&str) -> u32) -> String {
    if lines(text) <= max_lines {
        return text.to_string();
    }
    let cuts: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    let with_ellipsis = |n: usize| {
        let mut s = text[..cuts[n]].trim_end().to_string();
        s.push('…');
        s
    };
    // El mayor `n` (caracteres que se conservan) cuyo texto con "…" todavía entra.
    let (mut lo, mut hi) = (0usize, cuts.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if lines(&with_ellipsis(mid)) <= max_lines {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    with_ellipsis(lo)
}

/// El texto de un aviso tal como se dibuja: tal cual (nada se interpreta), sin caracteres de
/// control ni de dirección (que podrían disfrazar un texto), con `\r\n` como `\n`, y recortado a
/// `max_chars` caracteres con "…".
pub fn sanitize(text: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max_chars * 4));
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' => out.push('\n'),
            '\t' => out.push(' '),
            // Controles, y el texto bidireccional que reordena lo que se lee.
            c if c.is_control()
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}') =>
                {}
            c => out.push(c),
        }
    }
    let out = out.trim();
    if out.chars().count() <= max_chars {
        return out.to_string();
    }
    let mut cut: String = out.chars().take(max_chars.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// El botón de cerrar de una tarjeta.
pub fn close_rect(card: Rect, dpi: u32) -> Rect {
    let size = dip(CLOSE_SIZE_DIP, dpi);
    let inset = dip(CLOSE_INSET_DIP, dpi);
    Rect::new(
        card.right - inset - size,
        card.top + inset,
        card.right - inset,
        card.top + inset + size,
    )
}

/// ¿El punto (`x`, `y`, en el mismo espacio que `card`) cae sobre el botón de cerrar?
pub fn close_hit(card: Rect, dpi: u32, x: i32, y: i32) -> bool {
    close_rect(card, dpi).contains(x, y)
}

/// El tema de las apps de Windows: `AppsUseLightTheme` en 0 es oscuro; si falta (Windows viejos)
/// o trae otra cosa, claro.
pub fn is_dark_theme(apps_use_light_theme: Option<u32>) -> bool {
    apps_use_light_theme == Some(0)
}

/// Un color RGB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// `COLORREF` de GDI (`0x00BBGGRR`).
    pub fn colorref(self) -> u32 {
        u32::from(self.0) | u32::from(self.1) << 8 | u32::from(self.2) << 16
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    pub background: Rgb,
    pub border: Rgb,
    pub title: Rgb,
    pub body: Rgb,
    /// La franja del costado según el nivel.
    pub accent: Rgb,
    pub close: Rgb,
    /// El fondo del botón de cerrar con el puntero encima.
    pub close_hover: Rgb,
}

/// Los colores según el tema de las apps de Windows y el nivel del aviso (`info`, `success`,
/// `warn`, `error`; cualquier otro se ve como `info`).
pub fn palette(dark: bool, level: &str) -> Palette {
    let accent = match (dark, level) {
        (false, "success") => Rgb(16, 124, 16),
        (false, "warn") => Rgb(157, 93, 0),
        (false, "error") => Rgb(196, 43, 28),
        (false, _) => Rgb(0, 95, 184),
        (true, "success") => Rgb(108, 203, 95),
        (true, "warn") => Rgb(252, 225, 0),
        (true, "error") => Rgb(255, 153, 164),
        (true, _) => Rgb(96, 205, 255),
    };
    if dark {
        Palette {
            background: Rgb(43, 43, 43),
            border: Rgb(71, 71, 71),
            title: Rgb(255, 255, 255),
            body: Rgb(206, 206, 206),
            accent,
            close: Rgb(206, 206, 206),
            close_hover: Rgb(70, 70, 70),
        }
    } else {
        Palette {
            background: Rgb(249, 249, 249),
            border: Rgb(218, 218, 218),
            title: Rgb(26, 26, 26),
            body: Rgb(76, 76, 76),
            accent,
            close: Rgb(76, 76, 76),
            close_hover: Rgb(230, 230, 230),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920x1040: una pantalla de 1080p con la barra de tareas abajo.
    const WORK: Rect = Rect::new(0, 0, 1920, 1040);

    fn heights(dpi: u32, n: usize) -> Vec<i32> {
        vec![dip(CARD_MIN_HEIGHT_DIP, dpi); n]
    }

    fn inside(r: Rect, work: Rect) -> bool {
        r.left >= work.left && r.top >= work.top && r.right <= work.right && r.bottom <= work.bottom
    }

    fn overlap(a: Rect, b: Rect) -> bool {
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    }

    #[test]
    fn dip_scales_with_the_dpi_and_rounds() {
        assert_eq!(dip(12, 96), 12);
        assert_eq!(dip(12, 144), 18);
        assert_eq!(dip(12, 192), 24);
        assert_eq!(dip(12, 288), 36);
        assert_eq!(dip(5, 120), 6); // 6,25 -> 6
        assert_eq!(dip(10, 120), 13); // 12,5 -> 13
    }

    #[test]
    fn one_card_sits_in_the_bottom_right_corner_with_the_margin_scaled() {
        for dpi in [96u32, 144, 192, 288] {
            let h = heights(dpi, 1);
            let r = place(WORK, dpi, &h)[0];
            let margin = dip(MARGIN_DIP, dpi);
            assert_eq!(WORK.right - r.right, margin, "dpi {dpi}");
            assert_eq!(WORK.bottom - r.bottom, margin, "dpi {dpi}");
            assert_eq!(r.right - r.left, dip(CARD_WIDTH_DIP, dpi), "dpi {dpi}");
            assert_eq!(r.bottom - r.top, h[0], "dpi {dpi}");
        }
    }

    #[test]
    fn three_cards_stack_upward_newest_nearest_the_corner_without_overlap() {
        for dpi in [96u32, 120, 144, 192, 288] {
            let h = heights(dpi, 3);
            let rects = place(WORK, dpi, &h);
            assert_eq!(rects.len(), 3);
            for r in &rects {
                assert!(inside(*r, WORK), "dpi {dpi}: {r:?}");
            }
            // La última (la más nueva) es la de más abajo; la separación es el hueco escalado.
            assert!(rects[2].bottom > rects[1].bottom && rects[1].bottom > rects[0].bottom);
            assert_eq!(rects[2].top - rects[1].bottom, dip(GAP_DIP, dpi));
            assert_eq!(rects[1].top - rects[0].bottom, dip(GAP_DIP, dpi));
            assert!(!overlap(rects[0], rects[1]) && !overlap(rects[1], rects[2]));
        }
    }

    #[test]
    fn cards_of_different_heights_keep_their_own_height() {
        let h = [100, 160, 130];
        let rects = place(WORK, 96, &h);
        for (r, h) in rects.iter().zip(h) {
            assert_eq!(r.bottom - r.top, h);
        }
    }

    #[test]
    fn the_work_area_can_start_anywhere_taskbar_left_or_top() {
        // Barra a la izquierda (ancho 48) y a la arriba (alto 40), en una pantalla secundaria.
        for work in [
            Rect::new(48, 0, 1920, 1080),
            Rect::new(0, 40, 1920, 1080),
            Rect::new(1920, 0, 3840, 1040),
            Rect::new(-1920, 0, 0, 1040),
        ] {
            for dpi in [96u32, 144, 288] {
                let rects = place(work, dpi, &heights(dpi, 3));
                for r in &rects {
                    assert!(inside(*r, work), "{work:?} dpi {dpi}: {r:?}");
                }
                assert_eq!(work.right - rects[2].right, dip(MARGIN_DIP, dpi));
                assert_eq!(work.bottom - rects[2].bottom, dip(MARGIN_DIP, dpi));
            }
        }
    }

    #[test]
    fn a_stack_taller_than_the_screen_still_stays_inside() {
        // 300 % en una pantalla baja: no entran sin pisarse, pero ninguna se sale.
        let work = Rect::new(0, 0, 1280, 600);
        let rects = place(work, 288, &heights(288, 3));
        for r in &rects {
            assert!(inside(*r, work), "{r:?}");
        }
    }

    #[test]
    fn the_card_never_gets_wider_than_the_work_area() {
        let work = Rect::new(0, 0, 300, 600);
        let r = place(work, 96, &[100])[0];
        assert!(inside(r, work), "{r:?}");
        assert!(r.right - r.left > 0);
        assert_eq!(card_width(work, 96), r.right - r.left);
    }

    /// Un medidor falso: 10 caracteres por línea (sin cortar palabras).
    fn ten_per_line(s: &str) -> u32 {
        s.split('\n')
            .map(|l| (l.chars().count().max(1) as u32).div_ceil(10))
            .sum()
    }

    #[test]
    fn fit_keeps_text_that_already_fits() {
        assert_eq!(fit("hola", 3, ten_per_line), "hola");
        assert_eq!(fit(&"a".repeat(30), 3, ten_per_line), "a".repeat(30));
        assert_eq!(fit("", 2, ten_per_line), "");
    }

    #[test]
    fn fit_cuts_with_an_ellipsis_to_the_line_limit() {
        let cut = fit(&"a".repeat(100), 3, ten_per_line);
        assert!(cut.ends_with('…'), "{cut}");
        assert!(ten_per_line(&cut) <= 3, "{cut}");
        // Corta lo justo: con un carácter más ya no entraría.
        let mut longer = cut.trim_end_matches('…').to_string();
        longer.push('a');
        longer.push('…');
        assert!(ten_per_line(&longer) > 3, "{cut}");
        // Con 2 líneas, menos texto.
        let two = fit(&"a".repeat(100), 2, ten_per_line);
        assert!(two.chars().count() < cut.chars().count());
        assert!(ten_per_line(&two) <= 2);
    }

    #[test]
    fn fit_does_not_leave_a_space_before_the_ellipsis_and_respects_multibyte_chars() {
        let cut = fit("aaaa bbbb cccc dddd eeee ffff", 1, ten_per_line);
        assert!(cut.ends_with('…') && !cut.ends_with(" …"), "{cut}");
        let cut = fit(&"ñ😀".repeat(30), 2, ten_per_line);
        assert!(cut.ends_with('…'));
        assert!(ten_per_line(&cut) <= 2);
    }

    #[test]
    fn sanitize_leaves_markup_literal_and_drops_control_and_bidi_characters() {
        assert_eq!(
            sanitize("<img src=x onerror=alert(1)>", 100),
            "<img src=x onerror=alert(1)>"
        );
        assert_eq!(sanitize("\"); alert(1);//", 100), "\"); alert(1);//");
        assert_eq!(sanitize("a & b &amp; %s %d", 100), "a & b &amp; %s %d");
        assert_eq!(sanitize("a\u{0}b\u{1b}[31mc\u{7}", 100), "ab[31mc");
        assert_eq!(sanitize("x\u{202e}txt.exe", 100), "xtxt.exe");
        assert_eq!(sanitize("a\r\nb\tc", 100), "a\nb c");
        assert_eq!(sanitize("  hola \n", 100), "hola");
    }

    #[test]
    fn sanitize_truncates_long_text_by_characters() {
        let long = "ñ".repeat(500);
        let out = sanitize(&long, 200);
        assert_eq!(out.chars().count(), 200);
        assert!(out.ends_with('…'));
        assert_eq!(sanitize("corto", 200), "corto");
    }

    #[test]
    fn close_button_is_a_square_in_the_top_right_corner() {
        let card = Rect::new(1000, 500, 1360, 596); // 360x96 a 100 %
        let r = close_rect(card, 96);
        assert_eq!(r.right, card.right - dip(CLOSE_INSET_DIP, 96));
        assert_eq!(r.top, card.top + dip(CLOSE_INSET_DIP, 96));
        assert_eq!(r.right - r.left, dip(CLOSE_SIZE_DIP, 96));
        assert_eq!(r.bottom - r.top, dip(CLOSE_SIZE_DIP, 96));
    }

    #[test]
    fn close_hit_is_true_only_inside_the_button() {
        for dpi in [96u32, 144, 288] {
            let card = Rect::new(
                1000,
                500,
                1000 + dip(CARD_WIDTH_DIP, dpi),
                500 + dip(CARD_MIN_HEIGHT_DIP, dpi),
            );
            let b = close_rect(card, dpi);
            let (cx, cy) = ((b.left + b.right) / 2, (b.top + b.bottom) / 2);
            assert!(close_hit(card, dpi, cx, cy), "dpi {dpi}");
            assert!(close_hit(card, dpi, b.left, b.top), "dpi {dpi}");
            // Justo afuera del botón, y en el medio de la tarjeta.
            assert!(!close_hit(card, dpi, b.left - 1, cy), "dpi {dpi}");
            assert!(!close_hit(card, dpi, b.right, cy), "dpi {dpi}");
            assert!(!close_hit(card, dpi, cx, b.bottom), "dpi {dpi}");
            assert!(!close_hit(card, dpi, cx, b.top - 1), "dpi {dpi}");
            let middle = ((card.left + card.right) / 2, (card.top + card.bottom) / 2);
            assert!(!close_hit(card, dpi, middle.0, middle.1), "dpi {dpi}");
        }
    }

    #[test]
    fn dark_theme_is_apps_use_light_theme_equal_to_zero() {
        assert!(is_dark_theme(Some(0)));
        assert!(!is_dark_theme(Some(1)));
        // Sin el valor (Windows viejos) o con algo raro: claro.
        assert!(!is_dark_theme(None));
        assert!(!is_dark_theme(Some(7)));
    }

    #[test]
    fn palette_follows_the_theme_and_the_level() {
        let light = palette(false, "info");
        let dark = palette(true, "info");
        assert_ne!(light.background, dark.background);
        assert_ne!(light.title, light.background);
        assert_ne!(dark.title, dark.background);
        // El nivel solo cambia el acento.
        for dark_mode in [false, true] {
            let levels = ["info", "success", "warn", "error"].map(|l| palette(dark_mode, l));
            for (i, a) in levels.iter().enumerate() {
                assert_eq!(a.background, levels[0].background);
                for b in &levels[i + 1..] {
                    assert_ne!(a.accent, b.accent);
                }
            }
        }
        // Un nivel que no conocemos se ve como info.
        assert_eq!(palette(false, "raro"), light);
        assert_eq!(palette(true, ""), dark);
    }
}
