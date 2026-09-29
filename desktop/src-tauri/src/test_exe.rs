//! Para los tests: escribir un script ejecutable sin carreras de "Text file busy" (ETXTBSY).
//!
//! Si el proceso de tests escribe el archivo, mientras está abierto para escritura otro test (en
//! otro hilo) puede hacer fork: el hijo hereda el descriptor hasta su exec y, si en ese momento se
//! ejecuta el script, Linux devuelve ETXTBSY. Renombrar no alcanza (el descriptor apunta al mismo
//! inode). Acá lo escribe un `sh` aparte, que termina antes de que nadie lo ejecute: el proceso de
//! tests nunca tiene el archivo abierto.
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

pub fn write_executable(path: &Path, contents: &str) {
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(r#"cat >"$0" && chmod 755 "$0""#)
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(contents.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success(), "no pude escribir {path:?}");
}
