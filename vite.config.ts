import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function shortHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .slice(0, 12);
  } catch {
    return "dev";
  }
}

// Tauri dev server must stay on 1420 (see src-tauri/tauri.conf.json devUrl).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_COMMIT__: JSON.stringify(process.env.APP_COMMIT || shortHash()),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2020",
  },
});
