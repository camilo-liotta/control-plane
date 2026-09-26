//! El log del server: `server-<puerto>.log` en la carpeta de logs de la app, en modo append.
//! El server escribe directo al archivo (no a un pipe), así sigue aunque la app se cierre.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Pasado este tamaño, el log se rota a `.1` antes de la próxima corrida.
pub const ROTATE_AT: u64 = 5 * 1024 * 1024;
/// Líneas del log que se muestran cuando el server muere.
pub const TAIL_LINES: usize = 40;
/// Lo máximo que se lee del final del log para sacar esas líneas.
const TAIL_BYTES: u64 = 64 * 1024;

pub fn log_path(dir: &Path, port: u16) -> PathBuf {
    dir.join(format!("server-{port}.log"))
}

/// Abre el log para una corrida nueva: rota si hace falta y devuelve el archivo y el offset
/// desde el que escribe esta corrida.
pub fn open_for_run(path: &Path) -> io::Result<(File, u64)> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(path).is_ok_and(|m| m.len() > ROTATE_AT) {
        let mut old = path.as_os_str().to_owned();
        old.push(".1");
        fs::rename(path, PathBuf::from(old))?;
    }
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let offset = file.metadata()?.len();
    Ok((file, offset))
}

/// Las últimas `n` líneas escritas desde `offset` (solo de esta corrida).
pub fn tail_from(path: &Path, offset: u64, n: usize) -> Vec<String> {
    let Ok(mut f) = File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // Si el archivo es más chico que el offset, lo rotaron o lo truncaron: se lee desde el principio.
    let offset = if offset > len { 0 } else { offset };
    let start = offset.max(len.saturating_sub(TAIL_BYTES));
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    // Si se empezó a leer en el medio de una línea, esa primera va incompleta: afuera.
    if start > offset && !lines.is_empty() {
        lines.remove(0);
    }
    let skip = lines.len().saturating_sub(n);
    lines[skip..].iter().map(|l| l.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn tail_only_shows_this_run() {
        let dir = tempfile::tempdir().unwrap();
        let p = log_path(dir.path(), 4711);
        fs::write(&p, "corrida vieja 1\ncorrida vieja 2\n").unwrap();
        let (mut f, offset) = open_for_run(&p).unwrap();
        assert_eq!(offset, 32);
        for i in 0..50 {
            writeln!(f, "línea {i}").unwrap();
        }
        writeln!(f).unwrap();
        let tail = tail_from(&p, offset, TAIL_LINES);
        assert_eq!(tail.len(), 40);
        assert_eq!(tail.first().unwrap(), "línea 10");
        assert_eq!(tail.last().unwrap(), "línea 49");
        assert!(tail_from(&p, offset, 3)
            .iter()
            .all(|l| !l.contains("vieja")));
        assert_eq!(
            tail_from(&dir.path().join("nada.log"), 0, 5),
            Vec::<String>::new()
        );
    }

    #[test]
    fn rotates_big_logs() {
        let dir = tempfile::tempdir().unwrap();
        let p = log_path(dir.path(), 4711);
        fs::write(&p, vec![b'x'; (ROTATE_AT + 1) as usize]).unwrap();
        let (mut f, offset) = open_for_run(&p).unwrap();
        assert_eq!(offset, 0);
        writeln!(f, "nueva").unwrap();
        let rotated = dir.path().join("server-4711.log.1");
        assert_eq!(fs::metadata(&rotated).unwrap().len(), ROTATE_AT + 1);
        assert_eq!(tail_from(&p, offset, 5), vec!["nueva".to_string()]);
    }

    #[test]
    fn offset_past_the_end_reads_from_start() {
        let dir = tempfile::tempdir().unwrap();
        let p = log_path(dir.path(), 4711);
        fs::write(&p, "a\nb\n").unwrap();
        assert_eq!(
            tail_from(&p, 999, 5),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn long_logs_drop_the_partial_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let p = log_path(dir.path(), 4711);
        let mut text = String::new();
        while text.len() < (TAIL_BYTES as usize) * 2 {
            text.push_str("una línea bastante larga para llenar el log de prueba\n");
        }
        text.push_str("última\n");
        fs::write(&p, &text).unwrap();
        let tail = tail_from(&p, 0, TAIL_LINES);
        assert_eq!(tail.last().unwrap(), "última");
        assert!(tail
            .iter()
            .all(|l| l.starts_with("una línea") || l == "última"));
    }
}
