//! Archivos que se sueltan en la ventana: adjuntos para el chat.
//!
//! El webview no le da a la página los archivos que se sueltan (WebKitGTK solo pasa la ruta como
//! texto, y en la Mac el arrastre lo toma Tauri). La app los lee y se los pasa a la página con
//! `eval` a `window.__cpDesktop.dropFiles`: el canal es solo app → página, sale de un arrastre del
//! usuario y la página nunca ve las rutas.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use tauri::{DragDropEvent, Manager, Runtime, Window};

use crate::window::MAIN;

/// El mismo tope que el server pone a cada adjunto.
pub const MAX_BYTES: u64 = 30 * 1024 * 1024;
/// Un arrastre de más archivos que esto seguramente fue sin querer.
pub const MAX_FILES: usize = 20;

#[derive(Debug, PartialEq, Eq)]
pub enum Rejected {
    TooBig(u64),
    NotAFile,
    Unreadable(String),
}

impl Rejected {
    fn reason(&self) -> String {
        match self {
            Self::TooBig(size) => format!(
                "Pesa {} MB y el máximo es {} MB.",
                format!("{:.1}", *size as f64 / 1024.0 / 1024.0).replace('.', ","),
                MAX_BYTES / 1024 / 1024
            ),
            Self::NotAFile => "No es un archivo (las carpetas no se adjuntan).".into(),
            Self::Unreadable(err) => format!("No se pudo leer: {err}."),
        }
    }
}

/// Abre sin bloquearse: si entre el chequeo y la apertura aparece un FIFO, `open` no se cuelga.
fn open(path: &Path) -> std::io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NONBLOCK);
    }
    opts.open(path)
}

/// Lee un archivo regular de hasta `max` bytes. Sigue symlinks solo si terminan en un archivo
/// regular; carpetas, FIFOs y dispositivos se rechazan. El tamaño se chequea antes de leer y la
/// lectura nunca pasa de `max + 1` bytes, aunque el archivo crezca mientras tanto.
pub fn read_capped(path: &Path, max: u64) -> Result<Vec<u8>, Rejected> {
    let meta = std::fs::metadata(path).map_err(|e| Rejected::Unreadable(e.to_string()))?;
    if !meta.is_file() {
        return Err(Rejected::NotAFile);
    }
    if meta.len() > max {
        return Err(Rejected::TooBig(meta.len()));
    }
    let file = open(path).map_err(|e| Rejected::Unreadable(e.to_string()))?;
    // Lo abierto puede no ser lo que se chequeó: se vuelve a mirar sobre el descriptor.
    let meta = file
        .metadata()
        .map_err(|e| Rejected::Unreadable(e.to_string()))?;
    if !meta.is_file() {
        return Err(Rejected::NotAFile);
    }
    if meta.len() > max {
        return Err(Rejected::TooBig(meta.len()));
    }
    let mut data = Vec::with_capacity(meta.len() as usize);
    file.take(max + 1)
        .read_to_end(&mut data)
        .map_err(|e| Rejected::Unreadable(e.to_string()))?;
    if data.len() as u64 > max {
        return Err(Rejected::TooBig(data.len() as u64));
    }
    Ok(data)
}

/// El nombre que ve la página: solo el último componente, nunca la ruta.
pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "archivo".into())
}

/// El tipo por la extensión, para los que la web y Claude tratan distinto (imágenes, texto).
pub fn mime_for(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "sql" => "application/sql",
        "js" | "mjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "py" => "text/x-python",
        "zip" => "application/zip",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
}

#[derive(Serialize)]
pub struct Dropped {
    pub name: String,
    pub mime: &'static str,
    pub base64: String,
}

#[derive(Serialize)]
pub struct DropError {
    pub name: String,
    pub reason: String,
}

/// El JS que le pasa a la página archivos y errores. Todo va serializado con `serde_json`: ningún
/// nombre de archivo puede cerrar el string e inyectar código.
pub fn drop_script(files: &[Dropped], errors: &[DropError]) -> String {
    format!(
        "window.__cpDesktop?.dropFiles({}, {})",
        js_json(files),
        js_json(errors)
    )
}

/// JSON que además es JS en cualquier motor: U+2028 y U+2029 van escapados (antes de ES2019
/// cortaban un string literal).
fn js_json<T: Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v)
        .expect("se serializa siempre")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

pub fn dragging_script(on: bool) -> String {
    format!("window.__cpDesktop?.dragging?.({on})")
}

/// Lee lo soltado y lo manda a la página, un archivo por `eval` para no juntar todo en memoria.
fn deliver(paths: Vec<PathBuf>, eval: impl Fn(String)) {
    let extra = paths.len().saturating_sub(MAX_FILES);
    for path in paths.into_iter().take(MAX_FILES) {
        let name = file_name(&path);
        let script = match read_capped(&path, MAX_BYTES) {
            Ok(data) => drop_script(
                &[Dropped {
                    mime: mime_for(&name),
                    base64: base64::engine::general_purpose::STANDARD.encode(data),
                    name,
                }],
                &[],
            ),
            Err(err) => drop_script(
                &[],
                &[DropError {
                    reason: err.reason(),
                    name,
                }],
            ),
        };
        eval(script);
    }
    if extra > 0 {
        eval(drop_script(
            &[],
            &[DropError {
                name: format!("{extra} archivos más"),
                reason: format!("Se adjuntan hasta {MAX_FILES} por vez."),
            }],
        ));
    }
}

/// Los eventos de arrastre de la ventana principal.
pub fn on_event<R: Runtime>(win: &Window<R>, event: &DragDropEvent) {
    let Some(webview) = win.app_handle().get_webview_window(MAIN) else {
        return;
    };
    match event {
        DragDropEvent::Enter { paths, .. } if !paths.is_empty() => {
            let _ = webview.eval(dragging_script(true));
        }
        DragDropEvent::Leave => {
            let _ = webview.eval(dragging_script(false));
        }
        DragDropEvent::Drop { paths, .. } => {
            let _ = webview.eval(dragging_script(false));
            if paths.is_empty() {
                return;
            }
            let paths = paths.clone();
            // Leer 30 MB no puede frenar la ventana.
            std::thread::spawn(move || {
                deliver(paths, |script| {
                    let _ = webview.eval(script);
                })
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, bytes: usize) -> PathBuf {
        let p = dir.join(name);
        let mut f = File::create(&p).unwrap();
        f.write_all(&vec![b'x'; bytes]).unwrap();
        p
    }

    #[test]
    fn reads_up_to_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(dir.path(), "a.txt", 100);
        assert_eq!(read_capped(&p, 100).unwrap().len(), 100);
        assert_eq!(read_capped(&p, 99), Err(Rejected::TooBig(100)));
        let empty = write(dir.path(), "vacio.txt", 0);
        assert_eq!(read_capped(&empty, 10).unwrap().len(), 0);
    }

    #[test]
    fn rejects_folders_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_capped(dir.path(), MAX_BYTES), Err(Rejected::NotAFile));
        assert!(matches!(
            read_capped(&dir.path().join("no-existe"), MAX_BYTES),
            Err(Rejected::Unreadable(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinks_only_to_regular_files() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let file = write(dir.path(), "real.png", 10);
        let sub = dir.path().join("carpeta");
        std::fs::create_dir(&sub).unwrap();

        let to_file = dir.path().join("link-archivo");
        symlink(&file, &to_file).unwrap();
        assert_eq!(read_capped(&to_file, MAX_BYTES).unwrap().len(), 10);

        let to_dir = dir.path().join("link-carpeta");
        symlink(&sub, &to_dir).unwrap();
        assert_eq!(read_capped(&to_dir, MAX_BYTES), Err(Rejected::NotAFile));

        let to_dev = dir.path().join("link-dev");
        symlink("/dev/zero", &to_dev).unwrap();
        assert_eq!(read_capped(&to_dev, MAX_BYTES), Err(Rejected::NotAFile));

        let dangling = dir.path().join("link-roto");
        symlink(dir.path().join("nada"), &dangling).unwrap();
        assert!(matches!(
            read_capped(&dangling, MAX_BYTES),
            Err(Rejected::Unreadable(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifos_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(read_capped(&fifo, MAX_BYTES), Err(Rejected::NotAFile));
    }

    #[test]
    fn page_sees_only_the_name() {
        assert_eq!(file_name(Path::new("/home/x/privado/foto.png")), "foto.png");
        assert_eq!(file_name(Path::new("/")), "archivo");
    }

    #[test]
    fn mime_by_extension() {
        assert_eq!(mime_for("Captura.PNG"), "image/png");
        assert_eq!(mime_for("a.jpeg"), "image/jpeg");
        assert_eq!(mime_for("notas.md"), "text/markdown");
        assert_eq!(mime_for("sin-extension"), "application/octet-stream");
        assert_eq!(mime_for("raro.exe"), "application/octet-stream");
    }

    #[test]
    fn script_cannot_be_injected_with_names() {
        let names = [
            r#"a"); alert(1); //.png"#,
            "back\\slash\\\".txt",
            "salto\nde\rlínea.txt",
            "sep\u{2028}\u{2029}.txt",
            "</script><script>alert(1)</script>.txt",
            "${`plantilla`}.txt",
            "ñandú 🦤.png",
        ];
        for name in names {
            let files = [Dropped {
                name: name.into(),
                mime: "image/png",
                base64: "AAAA".into(),
            }];
            let errors = [DropError {
                name: name.into(),
                reason: format!("motivo {name}"),
            }];
            let script = drop_script(&files, &errors);
            let args = script
                .strip_prefix("window.__cpDesktop?.dropFiles(")
                .and_then(|s| s.strip_suffix(')'))
                .expect("forma fija");
            // Los dos argumentos son JSON válido y devuelven el nombre intacto.
            let mut de = serde_json::Deserializer::from_str(args).into_iter::<serde_json::Value>();
            let files_v = de.next().unwrap().unwrap();
            assert_eq!(files_v[0]["name"], name);
            let rest = args[de.byte_offset()..].trim_start();
            let errors_v: serde_json::Value =
                serde_json::from_str(rest.strip_prefix(',').unwrap()).unwrap();
            assert_eq!(errors_v[0]["name"], name);
            // Sin caracteres de control ni separadores de línea sueltos.
            assert!(!script
                .chars()
                .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}'));
        }
    }

    #[test]
    fn delivers_one_file_per_eval_and_reports_errors() {
        let dir = tempfile::tempdir().unwrap();
        let ok = write(dir.path(), "ok.png", 3);
        let sub = dir.path().join("carpeta");
        std::fs::create_dir(&sub).unwrap();
        let scripts = std::cell::RefCell::new(Vec::new());
        deliver(vec![ok, sub], |s| scripts.borrow_mut().push(s));
        let scripts = scripts.into_inner();
        assert_eq!(scripts.len(), 2);
        assert!(scripts[0].contains(r#""name":"ok.png","mime":"image/png","base64":"eHh4""#));
        assert!(!scripts[0].contains(dir.path().to_str().unwrap()));
        assert!(
            scripts[1].contains(r#""name":"carpeta""#) && scripts[1].contains("No es un archivo")
        );
    }

    #[test]
    fn caps_the_number_of_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (0..MAX_FILES + 3)
            .map(|i| write(dir.path(), &format!("{i}.txt"), 1))
            .collect();
        let n = std::cell::Cell::new(0);
        let last = std::cell::RefCell::new(String::new());
        deliver(paths, |s| {
            n.set(n.get() + 1);
            *last.borrow_mut() = s;
        });
        assert_eq!(n.get(), MAX_FILES + 1);
        assert!(last.borrow().contains("3 archivos más"));
    }
}
