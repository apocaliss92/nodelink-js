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
        "/docs": {
          target: "http://localhost:3000",
          // Keep original Host (localhost:5173) so /docs generates correct
          // absolute URLs for the tRPC panel (it should call back into Vite,
          // which then proxies /api/* to the server).
          changeOrigin: false,
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
