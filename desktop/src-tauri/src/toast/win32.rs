//! La capa Win32 de las tarjetas: aplica los [`Effect`]s del modelo con ventanas nativas y GDI.
//!
//! - Una ventana por tarjeta (`WS_POPUP`, `NOACTIVATE | TOOLWINDOW | TOPMOST`): nunca toma el foco,
//!   no sale en la barra de tareas ni en Alt-Tab. Opaca (sin `WS_EX_LAYERED`), así ClearType anda.
//! - Todo corre en el hilo principal, el mismo que bombea los mensajes de Tauri (tao): no hay hilo
//!   ni bucle propio. El estado vive en un `thread_local`; el modelo se toca con el préstamo
//!   tomado y los efectos se aplican **después** de soltarlo (crear, mover o destruir una ventana
//!   vuelve a entrar al `wndproc`, que usa `try_borrow_mut` y nunca entra en pánico hacia Win32).
//! - Cada tarjeta tiene su `SetTimer`; el puntero encima pausa todos (`TrackMouseEvent`). Sin
//!   sondeo: entre eventos el proceso no hace nada por los avisos.
//! - Sin tarjetas no queda nada: se sueltan las fuentes y el estado entero. Lo único que sigue es la
//!   clase de ventana registrada.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Dwm::{
    DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_BORDER_COLOR,
    DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreatePen,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, FrameRect, GetDC,
    GetMonitorInfoW, GetTextMetricsW, InvalidateRect, LineTo, MonitorFromPoint, MoveToEx,
    ReleaseDC, SelectObject, SetBkMode, SetTextColor, CLEARTYPE_QUALITY, DEFAULT_CHARSET,
    DT_CALCRECT, DT_EDITCONTROL, DT_NOPREFIX, DT_WORDBREAK, HDC, HFONT, MONITORINFO,
    MONITOR_DEFAULTTOPRIMARY, PAINTSTRUCT, PS_SOLID, SRCCOPY, TEXTMETRICW, TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Accessibility::NotifyWinEvent;
use windows_sys::Win32::UI::Controls::{MARGINS, WM_MOUSELEAVE};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetSystemMetrics, KillTimer,
    LoadCursorW, RegisterClassExW, SetCursor, SetTimer, SetWindowLongPtrW, SetWindowPos,
    SetWindowTextW, CHILDID_SELF, CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, EVENT_SYSTEM_ALERT,
    GWLP_USERDATA, HTCLIENT, HWND_TOPMOST, IDC_ARROW, IDC_HAND, MA_NOACTIVATE, OBJID_CLIENT,
    SM_CXSCREEN, SM_CYSCREEN, SPI_SETWORKAREA, SWP_NOACTIVATE, SWP_SHOWWINDOW, USER_TIMER_MINIMUM,
    WM_DISPLAYCHANGE, WM_DPICHANGED, WM_ERASEBKGND, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE,
    WM_MOUSEMOVE, WM_NCCREATE, WM_PAINT, WM_SETCURSOR, WM_SETTINGCHANGE, WM_TIMER, WNDCLASSEXW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use super::layout::{
    self, close_hit, close_rect, dip, fit, palette, sanitize, Palette, Rect, BODY_MAX_CHARS,
    BODY_MAX_LINES, CARD_MIN_HEIGHT_DIP, CLOSE_INSET_DIP, CLOSE_SIZE_DIP, TITLE_MAX_CHARS,
    TITLE_MAX_LINES,
};
use super::model::{CardId, Effect, Stack};
use crate::desktop_ws::Toast;
use crate::sys::registry;

const CLASS_NAME: &str = "ControlPlaneToast";
/// El id del `SetTimer` de cada tarjeta (el timer es de su ventana: no se cruzan).
const TIMER_ID: usize = 1;

const PAD_DIP: i32 = 12;
const ACCENT_DIP: i32 = 4;
const LINE_GAP_DIP: i32 = 4;
const TITLE_FONT_DIP: i32 = 14;
const BODY_FONT_DIP: i32 = 13;
/// Lo que se le deja de margen al título contra el botón de cerrar.
const CLOSE_GAP_DIP: i32 = 4;
/// Un timer puede llegar apenas antes de la hora que calculó el modelo (el reloj del sistema
/// avanza de a ~16 ms): hasta acá se lo da por vencido.
const TIMER_SLACK: Duration = Duration::from_millis(50);
const PERSONALIZE_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

/// El reloj. En las pruebas se puede adelantar, para no esperar 8 segundos de verdad.
#[cfg(not(test))]
fn now() -> Instant {
    Instant::now()
}

#[cfg(test)]
thread_local! {
    static CLOCK_OFFSET: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
}

#[cfg(test)]
fn now() -> Instant {
    Instant::now() + CLOCK_OFFSET.with(std::cell::Cell::get)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn to_rect(r: Rect) -> RECT {
    RECT {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    }
}

fn from_rect(r: RECT) -> Rect {
    Rect::new(r.left, r.top, r.right, r.bottom)
}

/// Las coordenadas con signo que trae el `lParam` de un mensaje del ratón.
fn point_of(lparam: LPARAM) -> (i32, i32) {
    (lparam as i16 as i32, (lparam >> 16) as i16 as i32)
}

/// El área de trabajo del monitor principal (sin la barra de tareas, esté donde esté).
fn primary_work_area() -> Rect {
    // SAFETY: MONITORINFO con cbSize puesto; el monitor se pide por un punto.
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            return from_rect(info.rcWork);
        }
        Rect::new(
            0,
            0,
            GetSystemMetrics(SM_CXSCREEN),
            GetSystemMetrics(SM_CYSCREEN),
        )
    }
}

/// El DPI efectivo del monitor principal (96 si no se puede saber).
fn primary_dpi() -> u32 {
    // SAFETY: salidas válidas; el monitor se pide por un punto.
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let (mut x, mut y) = (0u32, 0u32);
        if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y) == 0 && x > 0 {
            x
        } else {
            96
        }
    }
}

/// Las dos fuentes (título y cuerpo) con su alto de línea. Se sueltan al quedar sin tarjetas.
struct Fonts {
    title: HFONT,
    body: HFONT,
    title_lh: i32,
    body_lh: i32,
}

impl Fonts {
    fn new(dpi: u32) -> Self {
        let make = |dip_px: i32, weight: i32| {
            let face = wide("Segoe UI");
            // SAFETY: `face` termina en cero y vive durante la llamada.
            unsafe {
                CreateFontW(
                    -dip(dip_px, dpi),
                    0,
                    0,
                    0,
                    weight,
                    0,
                    0,
                    0,
                    u32::from(DEFAULT_CHARSET),
                    0,
                    0,
                    u32::from(CLEARTYPE_QUALITY),
                    0,
                    face.as_ptr(),
                )
            }
        };
        let (title, body) = (make(TITLE_FONT_DIP, 600), make(BODY_FONT_DIP, 400));
        let measure = Measure::new();
        Self {
            title,
            body,
            title_lh: measure.line_height(title),
            body_lh: measure.line_height(body),
        }
    }
}

impl Drop for Fonts {
    fn drop(&mut self) {
        // SAFETY: las fuentes son nuestras y ya no se usan.
        unsafe {
            DeleteObject(self.title);
            DeleteObject(self.body);
        }
    }
}

/// Mide texto con una fuente, sobre el DC de la pantalla.
struct Measure(HDC);

impl Measure {
    fn new() -> Self {
        // SAFETY: el DC de la pantalla se suelta en `Drop`.
        Self(unsafe { GetDC(std::ptr::null_mut()) })
    }

    fn line_height(&self, font: HFONT) -> i32 {
        // SAFETY: `tm` es una salida válida; se restaura la fuente anterior.
        unsafe {
            let old = SelectObject(self.0, font);
            let mut tm: TEXTMETRICW = std::mem::zeroed();
            GetTextMetricsW(self.0, &mut tm);
            SelectObject(self.0, old);
            tm.tmHeight.max(1)
        }
    }

    /// Cuántas líneas ocupa `text` en un ancho de `width` píxeles.
    fn lines(&self, font: HFONT, line_height: i32, text: &str, width: i32) -> u32 {
        if text.is_empty() {
            return 0;
        }
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut r = RECT {
            left: 0,
            top: 0,
            right: width.max(1),
            bottom: 0,
        };
        // SAFETY: el texto tiene `units.len()` unidades y se restaura la fuente anterior.
        let height = unsafe {
            let old = SelectObject(self.0, font);
            DrawTextW(
                self.0,
                units.as_ptr(),
                units.len() as i32,
                &mut r,
                DT_CALCRECT | DT_WORDBREAK | DT_EDITCONTROL | DT_NOPREFIX,
            );
            SelectObject(self.0, old);
            r.bottom - r.top
        };
        ((height + line_height - 1) / line_height).max(1) as u32
    }
}

impl Drop for Measure {
    fn drop(&mut self) {
        // SAFETY: es el DC que pidió `new`.
        unsafe { ReleaseDC(std::ptr::null_mut(), self.0) };
    }
}

/// Lo que se dibuja de una tarjeta, ya recortado y medido.
struct Content {
    title: Vec<u16>,
    body: Vec<u16>,
    title_h: i32,
    body_h: i32,
    height: i32,
    /// "título. cuerpo" para los lectores de pantalla (con fin de cadena).
    summary: Vec<u16>,
}

/// Prepara el texto de un aviso: se limpia (nada se interpreta), se recorta a las líneas que
/// entran y se mide la altura de la tarjeta.
fn compose(toast: &Toast, work: Rect, dpi: u32, fonts: &Fonts) -> Content {
    let width = layout::card_width(work, dpi);
    let left = dip(PAD_DIP + ACCENT_DIP, dpi);
    let title_w = width - left - dip(CLOSE_INSET_DIP + CLOSE_SIZE_DIP + CLOSE_GAP_DIP, dpi);
    let body_w = width - left - dip(PAD_DIP, dpi);

    let mut title_src = sanitize(&toast.title, TITLE_MAX_CHARS);
    if title_src.is_empty() {
        title_src = "control-plane".into();
    }
    let body_src = sanitize(toast.body.as_deref().unwrap_or(""), BODY_MAX_CHARS);

    let m = Measure::new();
    let title_lines = |t: &str| m.lines(fonts.title, fonts.title_lh, t, title_w);
    let body_lines = |t: &str| m.lines(fonts.body, fonts.body_lh, t, body_w);
    let title = fit(&title_src, TITLE_MAX_LINES, title_lines);
    let body = fit(&body_src, BODY_MAX_LINES, body_lines);
    let title_h = title_lines(&title) as i32 * fonts.title_lh;
    let body_h = body_lines(&body) as i32 * fonts.body_lh;

    let pad = dip(PAD_DIP, dpi);
    let gap = if body_h > 0 {
        dip(LINE_GAP_DIP, dpi)
    } else {
        0
    };
    let height = (pad + title_h + gap + body_h + pad).max(dip(CARD_MIN_HEIGHT_DIP, dpi));
    let summary = if body_src.is_empty() {
        title_src
    } else {
        format!("{title_src}. {body_src}")
    };
    Content {
        title: title.encode_utf16().collect(),
        body: body.encode_utf16().collect(),
        title_h,
        body_h,
        height,
        summary: wide(&summary),
    }
}

struct CardWin {
    hwnd: HWND,
    content: Content,
    /// Ya se mostró (y se avisó a los lectores de pantalla).
    shown: bool,
    /// El puntero está sobre la tarjeta.
    over: bool,
    /// El puntero está sobre el botón de cerrar.
    close_hover: bool,
    /// Se apretó el botón del ratón sobre esta tarjeta (el clic vale al soltarlo).
    pressed: bool,
    /// Hay un `TrackMouseEvent` pendiente.
    tracking: bool,
}

struct Host {
    stack: Stack,
    cards: HashMap<CardId, CardWin>,
    on_click: Arc<dyn Fn(Toast) + Send + Sync>,
    fonts: Fonts,
    dark: bool,
    dpi: u32,
    work: Rect,
}

impl Host {
    /// Se arma con la primera tarjeta de una ráfaga: el tema se lee ahora (una vez por ráfaga).
    fn new(on_click: Arc<dyn Fn(Toast) + Send + Sync>) -> Self {
        let apps_use_light = registry::get_dword(PERSONALIZE_KEY, "AppsUseLightTheme")
            .ok()
            .flatten();
        let dpi = primary_dpi();
        Self {
            stack: Stack::default(),
            cards: HashMap::new(),
            on_click,
            fonts: Fonts::new(dpi),
            dark: layout::is_dark_theme(apps_use_light),
            dpi,
            work: primary_work_area(),
        }
    }

    fn palette(&self, level: &str) -> Palette {
        palette(self.dark, level)
    }
}

thread_local! {
    /// `None` mientras no hay tarjetas: el costo en reposo es cero.
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

/// Toca el estado si no está prestado (si lo está, es una reentrada y se ignora).
fn with_host<T>(f: impl FnOnce(&mut Host) -> T) -> Option<T> {
    HOST.with(|c| {
        let mut b = c.try_borrow_mut().ok()?;
        b.as_mut().map(f)
    })
}

/// Muestra un aviso. Solo desde el hilo principal. `on_click` se llama (en ese mismo hilo) al tocar
/// la tarjeta, ya cerrada; con la "x" no se llama.
pub fn show(toast: Toast, on_click: Arc<dyn Fn(Toast) + Send + Sync>) {
    let fx = HOST.with(|c| {
        let mut b = c.try_borrow_mut().ok()?;
        let host = b.get_or_insert_with(|| Host::new(on_click.clone()));
        host.on_click = on_click;
        Some(host.stack.show(toast, now()))
    });
    apply(fx.unwrap_or_default());
}

/// Cierra todas las tarjetas y suelta todo. Solo desde el hilo principal.
pub fn clear() {
    let fx = with_host(|h| h.stack.clear());
    apply(fx.unwrap_or_default());
}

fn apply(effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Open(id) => open_card(id),
            Effect::Update(id) => update_card(id),
            Effect::Close(id) => close_card(id),
            Effect::Arm(id, after) => arm(id, after),
            Effect::Disarm(id) => disarm(id),
            Effect::Relayout => relayout(),
            Effect::Invoke(toast) => {
                if let Some(on_click) = with_host(|h| h.on_click.clone()) {
                    on_click(toast);
                }
            }
        }
    }
    release_if_idle();
}

/// Sin tarjetas no queda nada vivo: se sueltan las fuentes y el estado.
fn release_if_idle() {
    HOST.with(|c| {
        if let Ok(mut b) = c.try_borrow_mut() {
            if b.as_ref()
                .is_some_and(|h| h.stack.cards().is_empty() && h.cards.is_empty())
            {
                *b = None;
            }
        }
    });
}

fn card_hwnd(id: CardId) -> Option<HWND> {
    with_host(|h| h.cards.get(&id).map(|c| c.hwnd)).flatten()
}

fn ensure_class() {
    static REGISTERED: AtomicBool = AtomicBool::new(false);
    if REGISTERED.swap(true, Ordering::SeqCst) {
        return;
    }
    let name = wide(CLASS_NAME);
    // SAFETY: la estructura está completa y `name` vive durante la llamada (el sistema copia el
    // nombre).
    unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: GetModuleHandleW(std::ptr::null()),
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        if RegisterClassExW(&class) == 0
            && windows_sys::Win32::Foundation::GetLastError() != ERROR_CLASS_ALREADY_EXISTS
        {
            eprintln!("No pude registrar la ventana de los avisos.");
        }
    }
}

fn open_card(id: CardId) {
    ensure_class();
    let prepared = with_host(|h| {
        let toast = h.stack.cards().iter().find(|c| c.id == id)?.toast.clone();
        let content = compose(&toast, h.work, h.dpi, &h.fonts);
        let pal = h.palette(&toast.level);
        Some((
            content,
            pal.border,
            h.dark,
            layout::card_width(h.work, h.dpi),
        ))
    })
    .flatten();
    let Some((content, border, dark, width)) = prepared else {
        return;
    };
    let class = wide(CLASS_NAME);
    // SAFETY: cadenas con fin de cero; la ventana se crea en este hilo y `id` viaja en
    // `lpCreateParams` (el `wndproc` lo guarda al recibir WM_NCCREATE).
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class.as_ptr(),
            content.summary.as_ptr(),
            WS_POPUP,
            0,
            0,
            width,
            content.height,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            id as usize as *const c_void,
        )
    };
    if hwnd.is_null() {
        eprintln!("No pude crear la ventana de un aviso.");
        with_host(|h| h.stack.dismiss(id));
        return;
    }
    style_window(hwnd, dark, border);
    with_host(|h| {
        h.cards.insert(
            id,
            CardWin {
                hwnd,
                content,
                shown: false,
                over: false,
                close_hover: false,
                pressed: false,
                tracking: false,
            },
        )
    });
}

/// Esquinas redondeadas y sombra de Windows 11 (en Windows 10 se ignoran sin error), tema oscuro.
fn style_window(hwnd: HWND, dark: bool, border: layout::Rgb) {
    let set = |attr: i32, value: u32| {
        // SAFETY: `value` es un u32 vivo de 4 bytes, el tamaño que piden estos atributos.
        unsafe {
            DwmSetWindowAttribute(hwnd, attr as u32, std::ptr::from_ref(&value).cast(), 4);
        }
    };
    set(DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND as u32);
    set(DWMWA_USE_IMMERSIVE_DARK_MODE, u32::from(dark));
    set(DWMWA_BORDER_COLOR, border.colorref());
    // Un borde de vidrio de 1 px: así una ventana sin marco recibe la sombra del sistema.
    let margins = MARGINS {
        cxLeftWidth: 1,
        cxRightWidth: 1,
        cyTopHeight: 1,
        cyBottomHeight: 1,
    };
    // SAFETY: `margins` es válida durante la llamada.
    unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) };
}

fn update_card(id: CardId) {
    let hwnd = with_host(|h| {
        let toast = h.stack.cards().iter().find(|c| c.id == id)?.toast.clone();
        let content = compose(&toast, h.work, h.dpi, &h.fonts);
        let card = h.cards.get_mut(&id)?;
        let summary = content.summary.clone();
        card.content = content;
        Some((card.hwnd, summary))
    })
    .flatten();
    if let Some((hwnd, summary)) = hwnd {
        // SAFETY: ventana propia; el texto termina en cero.
        unsafe {
            SetWindowTextW(hwnd, summary.as_ptr());
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }
    }
}

fn close_card(id: CardId) {
    let Some(card) = with_host(|h| h.cards.remove(&id)).flatten() else {
        return;
    };
    // SAFETY: ventana propia; destruirla también borra sus timers.
    unsafe {
        KillTimer(card.hwnd, TIMER_ID);
        DestroyWindow(card.hwnd);
    }
}

fn arm(id: CardId, after: Duration) {
    if let Some(hwnd) = card_hwnd(id) {
        let ms = after.as_millis().min(i32::MAX as u128) as u32;
        // SAFETY: ventana propia; sin función de timer: llega WM_TIMER al `wndproc`.
        unsafe { SetTimer(hwnd, TIMER_ID, ms.max(USER_TIMER_MINIMUM), None) };
    }
}

fn disarm(id: CardId) {
    if let Some(hwnd) = card_hwnd(id) {
        // SAFETY: ventana propia.
        unsafe { KillTimer(hwnd, TIMER_ID) };
    }
}

/// Acomoda todas las tarjetas contra la esquina y muestra las que todavía no se vieron.
fn relayout() {
    struct Move {
        hwnd: HWND,
        rect: Rect,
        first_time: bool,
    }
    let moves: Vec<Move> = with_host(|h| {
        let ids: Vec<CardId> = h.stack.cards().iter().map(|c| c.id).collect();
        let heights: Vec<i32> = ids
            .iter()
            .map(|id| h.cards.get(id).map_or(0, |c| c.content.height))
            .collect();
        let rects = layout::place(h.work, h.dpi, &heights);
        ids.iter()
            .zip(rects)
            .filter_map(|(id, rect)| {
                let card = h.cards.get_mut(id)?;
                let first_time = !card.shown;
                card.shown = true;
                Some(Move {
                    hwnd: card.hwnd,
                    rect,
                    first_time,
                })
            })
            .collect()
    })
    .unwrap_or_default();
    for m in moves {
        // SAFETY: ventana propia. SWP_NOACTIVATE: mostrarla nunca le saca el foco a nadie.
        unsafe {
            SetWindowPos(
                m.hwnd,
                HWND_TOPMOST,
                m.rect.left,
                m.rect.top,
                m.rect.width(),
                m.rect.height(),
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            if m.first_time {
                // Que los lectores de pantalla la anuncien (el texto de la ventana es el aviso).
                NotifyWinEvent(
                    EVENT_SYSTEM_ALERT,
                    m.hwnd,
                    OBJID_CLIENT,
                    CHILDID_SELF as i32,
                );
            }
        }
    }
}

/// Cambió la pantalla (resolución, DPI, barra de tareas): se mide y se acomoda de nuevo.
fn metrics_changed() {
    with_host(|h| {
        h.work = primary_work_area();
        let dpi = primary_dpi();
        if dpi != h.dpi {
            h.dpi = dpi;
            h.fonts = Fonts::new(dpi);
        }
        let toasts: Vec<(CardId, Toast)> = h
            .stack
            .cards()
            .iter()
            .map(|c| (c.id, c.toast.clone()))
            .collect();
        for (id, toast) in toasts {
            let content = compose(&toast, h.work, h.dpi, &h.fonts);
            if let Some(card) = h.cards.get_mut(&id) {
                card.content = content;
            }
        }
    });
    apply(vec![Effect::Relayout]);
}

fn card_id(hwnd: HWND) -> CardId {
    // SAFETY: lectura del dato de usuario de una ventana propia.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, GWLP_USERDATA)
            as CardId
    }
}

fn client_rect(hwnd: HWND) -> Rect {
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: `r` es una salida válida.
    unsafe { GetClientRect(hwnd, &mut r) };
    from_rect(r)
}

fn on_mouse_move(hwnd: HWND, lparam: LPARAM) {
    let id = card_id(hwnd);
    let (x, y) = point_of(lparam);
    let area = client_rect(hwnd);
    let mut track = false;
    let mut repaint = false;
    let fx = with_host(|h| {
        let dpi = h.dpi;
        let card = h.cards.get_mut(&id)?;
        card.over = true;
        track = !card.tracking;
        card.tracking = true;
        let over_close = close_hit(area, dpi, x, y);
        repaint = over_close != card.close_hover;
        card.close_hover = over_close;
        Some(h.stack.hover(Some(id), now()))
    })
    .flatten();
    if track {
        let mut t = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        // SAFETY: estructura completa, ventana propia.
        unsafe { TrackMouseEvent(&mut t) };
    }
    if repaint {
        // SAFETY: ventana propia.
        unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
    }
    apply(fx.unwrap_or_default());
}

fn on_mouse_leave(hwnd: HWND) {
    let id = card_id(hwnd);
    let fx = with_host(|h| {
        let card = h.cards.get_mut(&id)?;
        card.over = false;
        card.tracking = false;
        card.pressed = false;
        card.close_hover = false;
        // Pasar de una tarjeta a otra: solo se retoma si el puntero ya no está sobre ninguna.
        let still_over = h.cards.values().any(|c| c.over);
        Some(if still_over {
            Vec::new()
        } else {
            h.stack.hover(None, now())
        })
    })
    .flatten();
    // SAFETY: ventana propia.
    unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
    apply(fx.unwrap_or_default());
}

fn on_button_down(hwnd: HWND) {
    let id = card_id(hwnd);
    with_host(|h| {
        if let Some(card) = h.cards.get_mut(&id) {
            card.pressed = true;
        }
    });
}

fn on_button_up(hwnd: HWND, lparam: LPARAM) {
    let id = card_id(hwnd);
    let (x, y) = point_of(lparam);
    let area = client_rect(hwnd);
    let fx = with_host(|h| {
        let dpi = h.dpi;
        let card = h.cards.get_mut(&id)?;
        // Solo vale un clic completo: apretar y soltar sobre la misma tarjeta.
        if !std::mem::take(&mut card.pressed) {
            return None;
        }
        Some(if close_hit(area, dpi, x, y) {
            h.stack.dismiss(id)
        } else {
            h.stack.click(id)
        })
    })
    .flatten();
    apply(fx.unwrap_or_default());
}

fn on_timer(hwnd: HWND) {
    let id = card_id(hwnd);
    // SAFETY: ventana propia (el timer se vuelve a pedir con `Arm` si hace falta).
    unsafe { KillTimer(hwnd, TIMER_ID) };
    let fx = with_host(|h| {
        let t = now();
        // Sin vencimiento: la tarjeta está pausada (o ya no existe) y es un aviso viejo de la cola.
        let deadline = h.stack.card_deadline(id)?;
        Some(if deadline <= t + TIMER_SLACK {
            h.stack.expire(id)
        } else {
            vec![Effect::Arm(id, deadline - t)]
        })
    })
    .flatten();
    apply(fx.unwrap_or_default());
}

fn paint(hwnd: HWND) {
    // SAFETY: BeginPaint/EndPaint siempre van de a pares (si no, Windows repite WM_PAINT).
    unsafe {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let dc = BeginPaint(hwnd, &mut ps);
        let id = card_id(hwnd);
        let area = client_rect(hwnd);
        HOST.with(|c| {
            if let Ok(b) = c.try_borrow() {
                if let Some(h) = b.as_ref() {
                    if let (Some(card), Some(model)) = (
                        h.cards.get(&id),
                        h.stack.cards().iter().find(|m| m.id == id),
                    ) {
                        draw(dc, area, h, card, &h.palette(&model.toast.level));
                    }
                }
            }
        });
        EndPaint(hwnd, &ps);
    }
}

/// Dibuja la tarjeta en un bitmap en memoria y lo copia de una vez (sin parpadeo).
///
/// # Safety
/// `dc` tiene que ser el DC de una pintura en curso.
unsafe fn draw(dc: HDC, area: Rect, host: &Host, card: &CardWin, pal: &Palette) {
    let (w, h) = (area.width().max(1), area.height().max(1));
    let mem = CreateCompatibleDC(dc);
    let bitmap = CreateCompatibleBitmap(dc, w, h);
    let old_bitmap = SelectObject(mem, bitmap);
    let dpi = host.dpi;
    let full = to_rect(Rect::new(0, 0, w, h));

    let fill = |rect: &RECT, color: layout::Rgb| {
        let brush = CreateSolidBrush(color.colorref());
        FillRect(mem, rect, brush);
        DeleteObject(brush);
    };
    fill(&full, pal.background);
    fill(
        &to_rect(Rect::new(0, 0, dip(ACCENT_DIP, dpi), h)),
        pal.accent,
    );
    let border = CreateSolidBrush(pal.border.colorref());
    FrameRect(mem, &full, border);
    DeleteObject(border);

    SetBkMode(mem, TRANSPARENT as i32);
    let left = dip(PAD_DIP + ACCENT_DIP, dpi);
    let top = dip(PAD_DIP, dpi);
    let text_flags = DT_WORDBREAK | DT_EDITCONTROL | DT_NOPREFIX;
    let content = &card.content;

    let old_font = SelectObject(mem, host.fonts.title);
    SetTextColor(mem, pal.title.colorref());
    let mut r = RECT {
        left,
        top,
        right: w - dip(CLOSE_INSET_DIP + CLOSE_SIZE_DIP + CLOSE_GAP_DIP, dpi),
        bottom: top + content.title_h,
    };
    DrawTextW(
        mem,
        content.title.as_ptr(),
        content.title.len() as i32,
        &mut r,
        text_flags,
    );
    if content.body_h > 0 {
        SelectObject(mem, host.fonts.body);
        SetTextColor(mem, pal.body.colorref());
        let mut r = RECT {
            left,
            top: top + content.title_h + dip(LINE_GAP_DIP, dpi),
            right: w - dip(PAD_DIP, dpi),
            bottom: top + content.title_h + dip(LINE_GAP_DIP, dpi) + content.body_h,
        };
        DrawTextW(
            mem,
            content.body.as_ptr(),
            content.body.len() as i32,
            &mut r,
            text_flags,
        );
    }
    SelectObject(mem, old_font);

    // El botón de cerrar: un recuadro si el puntero está encima y una "x" dibujada con líneas.
    let button = close_rect(Rect::new(0, 0, w, h), dpi);
    if card.close_hover {
        fill(&to_rect(button), pal.close_hover);
    }
    let pen = CreatePen(PS_SOLID, dip(1, dpi).max(1), pal.close.colorref());
    let old_pen = SelectObject(mem, pen);
    let inset = button.width() * 3 / 10;
    let (a, b) = (
        (button.left + inset, button.top + inset),
        (button.right - inset, button.bottom - inset),
    );
    MoveToEx(mem, a.0, a.1, std::ptr::null_mut());
    LineTo(mem, b.0, b.1);
    MoveToEx(mem, b.0, a.1, std::ptr::null_mut());
    LineTo(mem, a.0, b.1);
    SelectObject(mem, old_pen);
    DeleteObject(pen);

    BitBlt(dc, 0, 0, w, h, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old_bitmap);
    DeleteObject(bitmap);
    DeleteDC(mem);
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Un pánico no puede cruzar a Win32.
    std::panic::catch_unwind(|| handle(hwnd, msg, wparam, lparam)).unwrap_or(0)
}

fn handle(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: llamadas a Win32 con la ventana y los parámetros que trae el propio mensaje.
    unsafe {
        match msg {
            WM_NCCREATE => {
                let create = lparam as *const CREATESTRUCTW;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*create).lpCreateParams as isize);
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            // Ni al tocarla se activa: el foco sigue donde estaba.
            WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_SETCURSOR if (lparam & 0xffff) as u32 == HTCLIENT => {
                SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_HAND));
                1
            }
            WM_MOUSEMOVE => {
                on_mouse_move(hwnd, lparam);
                0
            }
            WM_MOUSELEAVE => {
                on_mouse_leave(hwnd);
                0
            }
            WM_LBUTTONDOWN => {
                on_button_down(hwnd);
                0
            }
            WM_LBUTTONUP => {
                on_button_up(hwnd, lparam);
                0
            }
            WM_TIMER if wparam == TIMER_ID => {
                on_timer(hwnd);
                0
            }
            WM_DISPLAYCHANGE | WM_DPICHANGED => {
                metrics_changed();
                0
            }
            WM_SETTINGCHANGE if wparam == SPI_SETWORKAREA as usize => {
                metrics_changed();
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

/// Para las pruebas: las ventanas vivas, de la más vieja a la más nueva.
#[cfg(test)]
fn test_hwnds() -> Vec<HWND> {
    with_host(|h| {
        h.stack
            .cards()
            .iter()
            .filter_map(|c| h.cards.get(&c.id).map(|w| w.hwnd))
            .collect()
    })
    .unwrap_or_default()
}

/// Para las pruebas: no queda estado (ni fuentes) de los avisos.
#[cfg(test)]
fn test_is_idle() -> bool {
    HOST.with(|c| c.borrow().is_none())
}

#[cfg(test)]
fn test_next_deadline() -> Option<Instant> {
    with_host(|h| h.stack.next_deadline()).flatten()
}

/// Para las pruebas: adelanta el reloj de este hilo.
#[cfg(test)]
fn test_advance(by: Duration) {
    CLOCK_OFFSET.with(|c| c.set(c.get() + by));
}

/// Para las pruebas: el centro del botón de cerrar, en coordenadas del cliente.
#[cfg(test)]
fn test_close_center(hwnd: HWND) -> (i32, i32) {
    let dpi = with_host(|h| h.dpi).unwrap_or(96);
    let b = close_rect(client_rect(hwnd), dpi);
    ((b.left + b.right) / 2, (b.top + b.bottom) / 2)
}

/// Para las pruebas: el texto de la ventana (lo que leen los lectores de pantalla).
#[cfg(test)]
fn window_text(hwnd: HWND) -> String {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let mut buf = [0u16; 1024];
    // SAFETY: el buffer tiene el tamaño que se informa.
    let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetForegroundWindow, GetWindowLongW, GetWindowRect, IsWindow,
        IsWindowVisible, PeekMessageW, SendMessageW, GWL_EXSTYLE, GWL_STYLE, MSG, PM_REMOVE,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_TIMER, WS_CAPTION, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    use super::*;

    /// Las pruebas muestran ventanas de verdad en el escritorio: de a una.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn toast(session: &str, title: &str) -> Toast {
        Toast {
            level: "info".into(),
            title: title.into(),
            body: Some("cuerpo".into()),
            session_id: Some(session.into()),
            ..Toast::default()
        }
    }

    fn quiet() -> Arc<dyn Fn(Toast) + Send + Sync> {
        Arc::new(|_| {})
    }

    /// Lo que haría el bucle de mensajes de la app.
    fn pump() {
        // SAFETY: MSG se llena por completo antes de usarse.
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                DispatchMessageW(&msg);
            }
        }
    }

    fn alive(h: HWND) -> bool {
        // SAFETY: IsWindow acepta cualquier valor.
        unsafe { IsWindow(h) != 0 }
    }

    fn xy(x: i32, y: i32) -> isize {
        ((y as u16 as isize) << 16) | (x as u16 as isize)
    }

    /// El clic de un usuario sobre la tarjeta, en coordenadas del cliente.
    fn click_at(h: HWND, x: i32, y: i32) {
        // SAFETY: mensajes a una ventana propia, en su hilo.
        unsafe {
            SendMessageW(h, WM_LBUTTONDOWN, 1, xy(x, y));
            SendMessageW(h, WM_LBUTTONUP, 0, xy(x, y));
        }
    }

    #[test]
    fn a_card_is_a_topmost_tool_popup_that_never_takes_the_foreground() {
        let _g = lock();
        // SAFETY: consulta sin efectos.
        let before = unsafe { GetForegroundWindow() };
        show(toast("a", "uno"), quiet());
        pump();
        let wins = test_hwnds();
        assert_eq!(wins.len(), 1);
        let w = wins[0];
        // SAFETY: consultas sobre una ventana propia que sigue viva.
        unsafe {
            let ex = GetWindowLongW(w, GWL_EXSTYLE) as u32;
            assert_ne!(ex & WS_EX_NOACTIVATE, 0, "sin activar");
            assert_ne!(ex & WS_EX_TOOLWINDOW, 0, "sin barra de tareas ni Alt-Tab");
            assert_ne!(ex & WS_EX_TOPMOST, 0, "siempre arriba");
            let style = GetWindowLongW(w, GWL_STYLE) as u32;
            assert_ne!(style & WS_POPUP, 0);
            assert_eq!(style & WS_CAPTION, 0, "sin borde ni título");
            assert_ne!(IsWindowVisible(w), 0, "a la vista");
            assert_eq!(GetForegroundWindow(), before, "no cambió el foco");
        }
        clear();
        pump();
        assert!(!alive(w));
    }

    #[test]
    fn cards_stay_inside_the_work_area_and_stack_without_overlap() {
        let _g = lock();
        show(toast("a", "uno"), quiet());
        show(toast("b", "dos"), quiet());
        show(toast("c", "tres"), quiet());
        pump();
        let wins = test_hwnds();
        assert_eq!(wins.len(), 3);
        let work = primary_work_area();
        let rects: Vec<RECT> = wins
            .iter()
            .map(|&h| {
                let mut r = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                // SAFETY: `r` es un RECT válido y la ventana está viva.
                unsafe { GetWindowRect(h, &mut r) };
                r
            })
            .collect();
        for r in &rects {
            assert!(
                r.left >= work.left && r.top >= work.top && r.right <= work.right,
                "{:?} fuera de {work:?}",
                from_rect(*r)
            );
            assert!(r.bottom <= work.bottom);
        }
        // La más nueva (la última) queda más abajo, y no se pisan.
        assert!(rects[2].top > rects[1].top && rects[1].top > rects[0].top);
        assert!(rects[0].bottom <= rects[1].top && rects[1].bottom <= rects[2].top);
        clear();
        pump();
    }

    #[test]
    fn a_fourth_card_destroys_the_oldest_window() {
        let _g = lock();
        for s in ["a", "b", "c"] {
            show(toast(s, s), quiet());
        }
        let first = test_hwnds()[0];
        show(toast("d", "d"), quiet());
        pump();
        assert_eq!(test_hwnds().len(), 3);
        assert!(!alive(first));
        clear();
        pump();
    }

    #[test]
    fn the_same_group_reuses_the_window() {
        let _g = lock();
        show(toast("a", "uno"), quiet());
        let first = test_hwnds()[0];
        show(toast("a", "uno de nuevo"), quiet());
        pump();
        assert_eq!(test_hwnds(), vec![first]);
        assert_eq!(window_text(first), "uno de nuevo. cuerpo");
        clear();
        pump();
    }

    #[test]
    fn a_click_invokes_the_callback_once_and_closes_the_card() {
        let _g = lock();
        let got = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = got.clone();
        show(
            toast("a", "uno"),
            Arc::new(move |t| seen.lock().unwrap().push(t.title)),
        );
        pump();
        let w = test_hwnds()[0];
        // En el medio de la tarjeta (lejos del botón de cerrar).
        click_at(w, 100, 40);
        pump();
        assert_eq!(*got.lock().unwrap(), vec!["uno".to_string()]);
        assert!(!alive(w));
        assert!(test_is_idle());
    }

    #[test]
    fn the_close_button_dismisses_without_invoking() {
        let _g = lock();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        show(
            toast("a", "uno"),
            Arc::new(move |_| {
                seen.fetch_add(1, Ordering::SeqCst);
            }),
        );
        pump();
        let w = test_hwnds()[0];
        let (x, y) = test_close_center(w);
        click_at(w, x, y);
        pump();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!alive(w));
        assert!(test_is_idle());
    }

    #[test]
    fn a_release_without_a_press_on_the_card_does_nothing() {
        let _g = lock();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        show(
            toast("a", "uno"),
            Arc::new(move |_| {
                seen.fetch_add(1, Ordering::SeqCst);
            }),
        );
        pump();
        let w = test_hwnds()[0];
        // SAFETY: mensaje a una ventana propia, en su hilo.
        unsafe { SendMessageW(w, WM_LBUTTONUP, 0, xy(100, 40)) };
        pump();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(alive(w));
        clear();
        pump();
    }

    #[test]
    fn the_timer_closes_the_card_and_releases_everything() {
        let _g = lock();
        show(toast("a", "uno"), quiet());
        pump();
        let w = test_hwnds()[0];
        assert!(test_next_deadline().is_some());
        // Un aviso de timer que llega antes de la hora (uno viejo de la cola): no cierra nada.
        // SAFETY: mensaje a una ventana propia, en su hilo.
        unsafe { SendMessageW(w, WM_TIMER, 1, 0) };
        pump();
        assert!(alive(w));
        // Ya pasó el tiempo (con el reloj adelantado): lo que manda el sistema al vencer el timer.
        test_advance(std::time::Duration::from_secs(11));
        // SAFETY: igual que arriba.
        unsafe { SendMessageW(w, WM_TIMER, 1, 0) };
        pump();
        assert!(!alive(w));
        assert!(test_is_idle());
        assert_eq!(test_next_deadline(), None);
        // Después, un aviso nuevo lo vuelve a crear todo.
        show(toast("b", "dos"), quiet());
        pump();
        assert_eq!(test_hwnds().len(), 1);
        clear();
        pump();
        assert!(test_is_idle());
    }

    #[test]
    fn the_pointer_over_a_card_pauses_the_timers() {
        let _g = lock();
        show(toast("a", "uno"), quiet());
        pump();
        let w = test_hwnds()[0];
        assert!(test_next_deadline().is_some());
        // SAFETY: mensaje a una ventana propia, en su hilo (sin bombear después: el sistema
        // avisaría enseguida que el puntero no está encima).
        unsafe { SendMessageW(w, WM_MOUSEMOVE, 0, xy(100, 40)) };
        assert_eq!(test_next_deadline(), None);
        clear();
        pump();
    }

    #[test]
    fn a_stale_timer_message_does_not_close_a_paused_card() {
        let _g = lock();
        show(toast("a", "uno"), quiet());
        pump();
        let w = test_hwnds()[0];
        // SAFETY: mensajes a una ventana propia, en su hilo.
        unsafe { SendMessageW(w, WM_MOUSEMOVE, 0, xy(100, 40)) };
        test_advance(std::time::Duration::from_secs(60));
        // SAFETY: igual que arriba.
        unsafe { SendMessageW(w, WM_TIMER, 1, 0) };
        assert!(alive(w));
        clear();
        pump();
    }

    #[test]
    fn a_burst_never_holds_more_than_three_windows_and_clears_to_idle() {
        let _g = lock();
        for i in 0..50 {
            show(toast(&format!("s{i}"), "aviso"), quiet());
        }
        pump();
        assert_eq!(test_hwnds().len(), 3);
        clear();
        pump();
        assert!(test_is_idle());
        assert!(test_hwnds().is_empty());
    }

    /// GDI y USER objects del proceso (lo que mira el Administrador de tareas en "Objetos GDI").
    fn gui_objects() -> (u32, u32) {
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, GetGuiResources, GR_GDIOBJECTS, GR_USEROBJECTS,
        };
        // SAFETY: el pseudo-handle del proceso propio no se cierra.
        unsafe {
            let me = GetCurrentProcess();
            (
                GetGuiResources(me, GR_GDIOBJECTS),
                GetGuiResources(me, GR_USEROBJECTS),
            )
        }
    }

    #[test]
    fn showing_and_clearing_over_and_over_does_not_leak_gdi_or_user_objects() {
        let _g = lock();
        let cycle = || {
            for s in ["a", "b", "c", "d"] {
                show(
                    toast(
                        s,
                        "un título algo largo para que ocupe más de una línea de la tarjeta",
                    ),
                    quiet(),
                );
            }
            pump();
            clear();
            pump();
        };
        // El primer ciclo puede crear cosas del sistema que quedan (cachés de DWM, temas).
        cycle();
        let (gdi, user) = gui_objects();
        for _ in 0..30 {
            cycle();
        }
        let (gdi2, user2) = gui_objects();
        assert!(test_is_idle());
        assert_eq!(
            (gdi2, user2),
            (gdi, user),
            "GDI {gdi}->{gdi2}, USER {user}->{user2}"
        );
    }

    #[test]
    fn clear_with_nothing_on_screen_creates_nothing() {
        let _g = lock();
        assert!(test_is_idle());
        clear();
        assert!(test_is_idle());
    }
}
