import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const entry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || "/",
  build: {
    rollupOptions: {
      // Tap ships as its own entry (tap.html) so the public tapper page stays
      // light and the Tap section can grow independently of the main app.
      input: {
        main: entry("index.html"),
        tap: entry("tap.html")
      }
    }
  },
  server: {
    port: 5177,
    proxy: {
      "/api": "http://127.0.0.1:4177"
    }
  }
});
