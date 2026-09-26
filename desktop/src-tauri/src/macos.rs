//! macOS: saber si el sistema se está apagando o cerrando la sesión.
//!
//! Si la app pregunta qué hacer con el server en ese momento, el diálogo frena el cierre de
//! sesión. Con `NSWorkspaceWillPowerOffNotification` (llega antes de que el sistema les pida a
//! las apps que terminen) la app sale sin preguntar; el server recibe SIGTERM del sistema y se
//! cierra ordenado. **Sin probar en una Mac todavía.**

use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use block2::RcBlock;
use objc2_app_kit::{NSWorkspace, NSWorkspaceWillPowerOffNotification};
use objc2_foundation::NSNotification;

pub fn watch_power_off(flag: Arc<AtomicBool>) {
    let block = RcBlock::new(move |_n: NonNull<NSNotification>| {
        flag.store(true, Ordering::SeqCst);
    });
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: el nombre es un static de AppKit y el bloque vive tanto como el observador, que
    // se deja vivo hasta que termine la app.
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceWillPowerOffNotification),
            None,
            None,
            &block,
        )
    };
    std::mem::forget(observer);
    std::mem::forget(block);
}
