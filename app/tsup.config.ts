import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: false,
  target: "node18",
  outDir: "dist",
  outExtension() {
    return {
      js: ".js",
    };
  },
});
