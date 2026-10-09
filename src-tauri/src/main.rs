#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = rebasely_lib::askpass_client() {
        std::process::exit(code);
    }
    rebasely_lib::run()
}
