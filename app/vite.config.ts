import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const isDev = mode === "development";

  return {
    root: path.resolve(__dirname, "client"),
    plugins: [react()],
    base: isDev ? "/" : "/static/",
    build: {
      outDir: path.resolve(__dirname, "dist/public"),
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://localhost:3000",
          changeOrigin: true,
        },
        "/go2rtc": {
          target: "http://localhost:3000",
          changeOrigin: true,
        },
        "/panel": {
          target: "http://localhost:3000",
          changeOrigin: false,
        },
        "/ws": {
          target: "ws://localhost:3000",
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
