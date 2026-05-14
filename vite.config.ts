import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Config Vite spécifique Tauri :
// - port fixe 1420 (Tauri s'y attend en dev)
// - HMR sur 1421
// - ignore les changements dans src-tauri (sinon boucle de reload pendant que Rust compile)
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
