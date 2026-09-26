//! El server empaquetado, fuera del AppImage.
//!
//! Un AppImage se monta en `/tmp/.mount_*` mientras la app corre y se desmonta al salir. Si el
//! usuario elige "dejarlo corriendo", el server tiene que seguir encontrando su web y su hook de
//! compactación: por eso, desde un AppImage, el bundle se copia una vez a la carpeta de datos de
//! la app y el server se lanza desde ahí. El `.deb` y el `.app` de macOS lo usan en su lugar.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Lo que identifica un bundle: el server, el hook y el `index.html` de la web (que nombra los
/// assets con hash). FNV-1a de 64 bits: estable entre versiones de Rust.
pub fn fingerprint(bundle: &Path) -> io::Result<String> {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for rel in ["server.mjs", "compact-hook.mjs", "web/index.html"] {
        for b in fs::read(bundle.join(rel))?.iter().chain(rel.as_bytes()) {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    Ok(format!("{h:016x}"))
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &to)?;
        }
        // Symlinks: el bundle no trae; se ignoran para no apuntar de vuelta al montaje.
    }
    Ok(())
}

/// Copia `src` a `<root>/<version>-<huella>/` si todavía no está y devuelve esa carpeta. La copia
/// va primero a una carpeta temporal y después se renombra: nunca queda una a medias.
pub fn persistent_copy(src: &Path, root: &Path, version: &str) -> io::Result<PathBuf> {
    let dest = root.join(format!("{version}-{}", fingerprint(src)?));
    if dest.join("server.mjs").is_file() {
        return Ok(dest);
    }
    fs::create_dir_all(root)?;
    let tmp = root.join(format!(".tmp-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    copy_dir(src, &tmp)?;
    match fs::rename(&tmp, &dest) {
        Ok(()) => Ok(dest),
        // Otra instancia la copió al mismo tiempo: vale la suya.
        Err(_) if dest.join("server.mjs").is_file() => {
            let _ = fs::remove_dir_all(&tmp);
            Ok(dest)
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(dir: &Path, server: &str) {
        fs::create_dir_all(dir.join("web/assets")).unwrap();
        fs::write(dir.join("server.mjs"), server).unwrap();
        fs::write(dir.join("compact-hook.mjs"), "hook").unwrap();
        fs::write(dir.join("web/index.html"), "<html>").unwrap();
        fs::write(dir.join("web/assets/a.js"), "js").unwrap();
    }

    #[test]
    fn copies_once_and_reuses() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("mnt/app");
        bundle(&src, "v1");
        let root = t.path().join("data/server-bundle");
        let a = persistent_copy(&src, &root, "0.1.0").unwrap();
        assert!(a.starts_with(&root));
        assert!(a
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("0.1.0-"));
        assert_eq!(fs::read_to_string(a.join("web/assets/a.js")).unwrap(), "js");
        // Sigue ahí aunque el origen (el montaje) desaparezca.
        fs::remove_dir_all(t.path().join("mnt")).unwrap();
        assert!(a.join("server.mjs").is_file());
        // Mismo contenido: la misma carpeta, sin volver a copiar.
        bundle(&src, "v1");
        assert_eq!(persistent_copy(&src, &root, "0.1.0").unwrap(), a);
        // Sin temporales sueltos.
        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn a_different_build_gets_its_own_folder() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("app");
        let root = t.path().join("root");
        bundle(&src, "v1");
        let a = persistent_copy(&src, &root, "0.1.0").unwrap();
        bundle(&src, "v2");
        let b = persistent_copy(&src, &root, "0.1.0").unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read_to_string(b.join("server.mjs")).unwrap(), "v2");
    }

    #[test]
    fn incomplete_bundle_is_an_error() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("app")).unwrap();
        assert!(persistent_copy(&t.path().join("app"), &t.path().join("root"), "0.1.0").is_err());
    }
}
