//! Registro de Windows (solo `HKEY_CURRENT_USER`): lo justo para el inicio automático. Las claves
//! se pasan como subruta (`Software\...`) y que el valor o la clave no existan no es un error.

use std::io;

use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
};
use windows_sys::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
    RRF_RT_REG_BINARY, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
#[cfg(test)]
use windows_sys::Win32::System::Registry::{RegDeleteKeyW, REG_BINARY, REG_DWORD};

/// Texto UTF-16 terminado en cero, como lo pide la API.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn check(code: u32) -> io::Result<()> {
    if code == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

/// Lee un valor del tipo pedido (`flags`): `None` si la clave o el valor no existen.
fn get_raw(subkey: &str, name: &str, flags: u32) -> io::Result<Option<Vec<u8>>> {
    let (key, name) = (wide(subkey), wide(name));
    let mut buf = vec![0u8; 256];
    loop {
        let mut size = buf.len() as u32;
        // SAFETY: las cadenas terminan en cero y `buf` tiene `size` bytes escribibles.
        let code = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                flags,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match code {
            ERROR_SUCCESS => {
                buf.truncate(size as usize);
                return Ok(Some(buf));
            }
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => return Ok(None),
            // `size` trae lo que hace falta (puede crecer entre la consulta y la lectura).
            ERROR_MORE_DATA => buf.resize((size as usize).max(buf.len()) + 64, 0),
            other => return Err(io::Error::from_raw_os_error(other as i32)),
        }
    }
}

pub fn get_string(subkey: &str, name: &str) -> io::Result<Option<String>> {
    Ok(get_raw(subkey, name, RRF_RT_REG_SZ)?.map(|bytes| {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|u| *u != 0)
            .collect();
        String::from_utf16_lossy(&units)
    }))
}

pub fn get_binary(subkey: &str, name: &str) -> io::Result<Option<Vec<u8>>> {
    get_raw(subkey, name, RRF_RT_REG_BINARY)
}

pub fn get_dword(subkey: &str, name: &str) -> io::Result<Option<u32>> {
    Ok(get_raw(subkey, name, RRF_RT_REG_DWORD)?
        .and_then(|b| <[u8; 4]>::try_from(b.as_slice()).ok())
        .map(u32::from_le_bytes))
}

/// Escribe un valor (crea la clave si hace falta).
pub(crate) fn set_raw(subkey: &str, name: &str, kind: u32, data: &[u8]) -> io::Result<()> {
    let (key, name) = (wide(subkey), wide(name));
    // SAFETY: las cadenas terminan en cero y `data` tiene `len` bytes legibles.
    check(unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            kind,
            data.as_ptr().cast(),
            data.len() as u32,
        )
    })
}

pub fn set_string(subkey: &str, name: &str, value: &str) -> io::Result<()> {
    let bytes: Vec<u8> = wide(value).into_iter().flat_map(u16::to_le_bytes).collect();
    set_raw(subkey, name, REG_SZ, &bytes)
}

/// Borra un valor; que no exista (o que no exista la clave) es éxito.
pub fn delete_value(subkey: &str, name: &str) -> io::Result<()> {
    let (key, name) = (wide(subkey), wide(name));
    // SAFETY: las cadenas terminan en cero.
    match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(()),
        code => check(code),
    }
}

/// Borra una clave sin subclaves (para limpiar las pruebas; los errores no importan).
#[cfg(test)]
fn delete_key(subkey: &str) {
    let key = wide(subkey);
    // SAFETY: la cadena termina en cero.
    unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, key.as_ptr()) };
}

/// Una clave propia de una prueba (con hasta dos subclaves, `Run` y `Approved`), que se borra al
/// terminar, también si la prueba falla.
#[cfg(test)]
pub(crate) struct Scratch(pub String);

#[cfg(test)]
impl Scratch {
    pub fn new() -> Self {
        Self(format!(
            r"Software\control-plane-tests\{}",
            crate::screen::random_hex()
        ))
    }

    pub fn child(&self, name: &str) -> String {
        format!(r"{}\{name}", self.0)
    }
}

#[cfg(test)]
impl Drop for Scratch {
    fn drop(&mut self) {
        delete_key(&self.child("Run"));
        delete_key(&self.child("Approved"));
        delete_key(&self.0);
        delete_key(r"Software\control-plane-tests");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_roundtrip_overwrite_and_delete() {
        let key = Scratch::new();
        assert_eq!(get_string(&key.0, "v").unwrap(), None);
        set_string(&key.0, "v", r#""C:\Program Files\Ñ\a.exe" --hidden"#).unwrap();
        assert_eq!(
            get_string(&key.0, "v").unwrap().as_deref(),
            Some(r#""C:\Program Files\Ñ\a.exe" --hidden"#)
        );
        set_string(&key.0, "v", "otro").unwrap();
        assert_eq!(get_string(&key.0, "v").unwrap().as_deref(), Some("otro"));
        delete_value(&key.0, "v").unwrap();
        assert_eq!(get_string(&key.0, "v").unwrap(), None);
    }

    #[test]
    fn long_strings_survive_the_buffer_resize() {
        let key = Scratch::new();
        let long = "x".repeat(5000);
        set_string(&key.0, "v", &long).unwrap();
        assert_eq!(get_string(&key.0, "v").unwrap().as_deref(), Some(&*long));
    }

    #[test]
    fn deleting_what_is_not_there_is_ok() {
        let key = Scratch::new();
        // La clave no existe.
        delete_value(&key.0, "nada").unwrap();
        // La clave existe, el valor no.
        set_string(&key.0, "otro", "1").unwrap();
        delete_value(&key.0, "nada").unwrap();
        assert_eq!(get_string(&key.0, "otro").unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn binary_and_dword_values_are_read_by_type() {
        let key = Scratch::new();
        set_raw(&key.0, "bin", REG_BINARY, &[0x03, 0, 0, 0, 9]).unwrap();
        set_raw(&key.0, "dw", REG_DWORD, &7u32.to_le_bytes()).unwrap();
        assert_eq!(
            get_binary(&key.0, "bin").unwrap().as_deref(),
            Some(&[0x03, 0, 0, 0, 9][..])
        );
        assert_eq!(get_dword(&key.0, "dw").unwrap(), Some(7));
        assert_eq!(get_binary(&key.0, "nada").unwrap(), None);
        assert_eq!(get_dword(&key.0, "nada").unwrap(), None);
        // Un valor de otro tipo no se confunde con el pedido.
        assert!(get_dword(&key.0, "bin").is_err());
    }
}
