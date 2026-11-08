import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies the existing Python services, so neither needs CORS changes:
//   /api/*    -> FastAPI backend on :8000 (REST)        /ws/* -> its WebSocket
//   /signal/* -> scripts/live_signal.py on :8766 (device-setup signal checker)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/ws": { target: "ws://localhost:8000", ws: true },
      "/signal": { target: "http://localhost:8766", changeOrigin: true, rewrite: (p) => p.replace(/^\/signal/, "") },
    },
  },
});
