// Sin consola extra en Windows (release).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    control_plane_desktop_lib::run();
}
