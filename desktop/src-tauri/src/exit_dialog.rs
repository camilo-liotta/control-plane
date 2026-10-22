//! El diálogo de salida con "Recordar mi elección".
//!
//! El diálogo del plugin no tiene casillas, así que acá se arma uno nativo: en Linux un
//! `GtkMessageDialog` con una casilla en el área del mensaje; en macOS un `NSAlert` con su
//! botón de supresión (la casilla que trae para "no volver a preguntar"). Los dos corren en el
//! hilo principal; quien llama (el hilo del sidecar) espera la respuesta.

use std::sync::mpsc;

use tauri::{AppHandle, Runtime};

/// Qué botón se tocó (`None`: se cerró el diálogo o se canceló) y si se tildó "Recordar".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    /// 0: el primero (el principal), 1: el segundo, 2: el tercero.
    pub button: Option<usize>,
    pub remember: bool,
}

#[cfg(not(windows))]
pub const REMEMBER: &str = "Recordar mi elección";

/// Muestra el diálogo y espera. `buttons`: el principal, el otro y el de cancelar.
pub fn ask<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    message: &str,
    buttons: [&str; 3],
) -> Choice {
    let (tx, rx) = mpsc::channel();
    let (title, message) = (title.to_string(), message.to_string());
    let buttons = buttons.map(str::to_string);
    let shown = app.run_on_main_thread(move || {
        let _ = tx.send(show(&title, &message, &buttons));
    });
    let cancel = Choice {
        button: None,
        remember: false,
    };
    if shown.is_err() {
        return cancel;
    }
    rx.recv().unwrap_or(cancel)
}

#[cfg(target_os = "linux")]
fn show(title: &str, message: &str, buttons: &[String; 3]) -> Choice {
    use gtk::prelude::*;
    use gtk::{ButtonsType, CheckButton, DialogFlags, MessageDialog, MessageType, ResponseType};

    let dialog = MessageDialog::new(
        None::<&gtk::Window>,
        DialogFlags::MODAL,
        MessageType::Question,
        ButtonsType::None,
        title,
    );
    dialog.set_title(title);
    dialog.set_secondary_text(Some(message));
    dialog.set_keep_above(true);
    // GTK los pone de izquierda a derecha: cancelar primero y el principal a la derecha.
    dialog.add_button(&buttons[2], ResponseType::Cancel);
    dialog.add_button(&buttons[1], ResponseType::Other(1));
    dialog.add_button(&buttons[0], ResponseType::Other(0));
    dialog.set_default_response(ResponseType::Other(0));
    let remember = CheckButton::with_label(REMEMBER);
    if let Ok(area) = dialog.message_area().downcast::<gtk::Box>() {
        area.pack_start(&remember, false, false, 0);
    }
    remember.show();
    let response = dialog.run();
    let checked = remember.is_active();
    // SAFETY: el diálogo es nuestro y nadie más lo usa después.
    unsafe { dialog.destroy() };
    let button = match response {
        ResponseType::Other(n) if n <= 1 => Some(n as usize),
        _ => None,
    };
    Choice {
        button,
        remember: checked && button.is_some(),
    }
}

/// En Windows, un `MessageBox` de Sí / No / Cancelar (sin casilla: no se recuerda la elección).
#[cfg(windows)]
fn show(title: &str, message: &str, _buttons: &[String; 3]) -> Choice {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDNO, IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNOCANCEL,
    };

    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(message), wide(title));
    // SAFETY: los dos buffers terminan en NUL y viven hasta que vuelve la llamada.
    let response = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_YESNOCANCEL | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };
    let button = match response {
        IDYES => Some(0),
        IDNO => Some(1),
        _ => None,
    };
    Choice {
        button,
        remember: false,
    }
}

#[cfg(target_os = "macos")]
fn show(title: &str, message: &str, buttons: &[String; 3]) -> Choice {
    use objc2_app_kit::{
        NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSApplication,
        NSControlStateValueOn,
    };
    use objc2_foundation::{MainThreadMarker, NSString};

    let cancel = Choice {
        button: None,
        remember: false,
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return cancel;
    };
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(title));
    alert.setInformativeText(&NSString::from_str(message));
    // En macOS el primero es el principal (a la derecha) y "Cancelar" responde a Esc.
    for b in buttons {
        alert.addButtonWithTitle(&NSString::from_str(b));
    }
    alert.setShowsSuppressionButton(true);
    if let Some(check) = alert.suppressionButton() {
        check.setTitle(&NSString::from_str(REMEMBER));
    }
    #[allow(deprecated)]
    NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    let response = alert.runModal();
    let button = if response == NSAlertFirstButtonReturn {
        Some(0)
    } else if response == NSAlertSecondButtonReturn {
        Some(1)
    } else {
        None
    };
    let checked = alert
        .suppressionButton()
        .is_some_and(|b| b.state() == NSControlStateValueOn);
    Choice {
        button,
        remember: checked && button.is_some(),
    }
}
