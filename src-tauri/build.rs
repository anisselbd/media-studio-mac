// Script de build Cargo : c'est lui qui prépare les ressources Tauri
// (capabilities, icônes, infos bundle…) avant la compilation Rust.
fn main() {
    tauri_build::build()
}
