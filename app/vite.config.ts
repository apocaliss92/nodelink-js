import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";
  // Allow proxying to a non-default backend port (e.g. when 3000 is held by
  // the Reolink desktop app). Honors PROXY_PORT first, then PORT, default 3000.
  const apiPort = process.env.PROXY_PORT || process.env.PORT || "3000";

  return {
    root: path.resolve(__dirname, "client"),
    plugins: [react(), tailwindcss()],
    base: isDev ? "/" : "/static/",
    build: {
      outDir: path.resolve(__dirname, "dist/public"),
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      port: Number(process.env.VITE_PORT) || 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
        "/panel": {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: false,
        },
        "/ws": {
          target: `ws://127.0.0.1:${apiPort}`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
