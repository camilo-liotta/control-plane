fn main() {
    // El bundle del server va entre los recursos de la app (lo genera `npm run stage`, que
    // corren `tauri dev` y `tauri build` antes de compilar). Para `cargo test` o `clippy` a
    // secas alcanza con que la carpeta exista.
    let _ = std::fs::create_dir_all("../server-bundle");
    tauri_build::build()
}
