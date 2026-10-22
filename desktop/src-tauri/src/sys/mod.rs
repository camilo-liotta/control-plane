//! Process primitives that differ per OS: liveness, signals/termination, detached spawn.
//!
//! The backend is picked at compile time: unix (Linux, macOS) or windows.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// Registro de Windows (HKCU), para el inicio automático.
#[cfg(windows)]
pub mod registry;
