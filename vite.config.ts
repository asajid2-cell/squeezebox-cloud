import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || "/",
  server: {
    port: 5177,
    proxy: {
      "/api": "http://127.0.0.1:4177"
    }
  }
});
