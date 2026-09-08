import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri dev server must stay on 1420 (see src-tauri/tauri.conf.json devUrl).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2020",
  },
});
