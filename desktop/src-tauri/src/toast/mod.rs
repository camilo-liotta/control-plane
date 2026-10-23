//! Los avisos propios de Windows: tarjetas nativas (una ventana Win32 por tarjeta, dibujada con GDI).
//!
//! No hay WebView, hilo, timer ni objeto GDI mientras no haya una tarjeta a la vista: la primera
//! crea lo que hace falta y la última lo suelta todo. El núcleo (`model`, `layout`) es puro: decide
//! y devuelve efectos, sin tocar el sistema. Por eso se compila también en las pruebas de Linux y
//! macOS. Lo único con `unsafe` es `win32`, que aplica esos efectos en el hilo principal (el mismo
//! que ya bombea mensajes para las ventanas de Tauri: no hace falta otro bucle).
#![cfg_attr(not(windows), allow(dead_code))]

pub mod layout;
pub mod model;
#[cfg(windows)]
pub mod win32;
