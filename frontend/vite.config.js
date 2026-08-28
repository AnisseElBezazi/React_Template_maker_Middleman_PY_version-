import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Le backend FastAPI tourne sur 8100 (8000 est pris par le Docker Middleman).
// Le proxy evite d'avoir a gerer CORS et des URLs absolues dans le front.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8100", changeOrigin: true },
      "/out": { target: "http://127.0.0.1:8100", changeOrigin: true },
      "/uploads": { target: "http://127.0.0.1:8100", changeOrigin: true },
      "/editor-overlay.js": { target: "http://127.0.0.1:8100", changeOrigin: true },
    },
  },
});
