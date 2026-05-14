// Empêche l'apparition d'une fenêtre de console noire sous Windows
// (sans effet sur macOS, mais c'est la convention Tauri).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Délègue tout à la lib partagée — pratique pour ajouter une cible mobile plus tard.
    projet_app_audio_lib::run()
}
