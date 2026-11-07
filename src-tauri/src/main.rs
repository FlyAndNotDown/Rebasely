#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = rebaseraven_lib::askpass_client() {
        std::process::exit(code);
    }
    rebaseraven_lib::run()
}
