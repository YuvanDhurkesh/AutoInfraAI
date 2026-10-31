import react from "@vitejs/plugin-react";

export default {
  plugins: [react()],
  server: {
    proxy: {
      "/todos": "http://localhost:4000",
      "/auth": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
};
