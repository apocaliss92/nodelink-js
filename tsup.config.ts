import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/rtsp-server.ts", "src/cli/hub-emu.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node18",
  outDir: "dist",
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
});

