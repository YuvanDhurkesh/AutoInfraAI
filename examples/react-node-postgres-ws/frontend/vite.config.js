import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Local dev: forward /api (including the WebSocket) to the API server.
  server: { proxy: { "/api": { target: "http://127.0.0.1:4000", ws: true } } },
});
