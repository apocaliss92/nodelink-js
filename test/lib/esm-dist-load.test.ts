import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const distEsm = path.resolve(__dirname, "../../dist/index.js");
const distCjs = path.resolve(__dirname, "../../dist/index.cjs");

// Regression for the alawmulaw named-import crash in dist/index.js (ESM).
// vitest's own loader hides the failure because it transpiles src/; only a real
// Node ESM/CJS interop boundary reproduces it. Skip cleanly when the bundle
// hasn't been built so dev runs don't fail.
describe("built bundle loads under real Node ESM/CJS interop", () => {
  it.skipIf(!existsSync(distEsm))("dist/index.js imports without throwing", () => {
    const res = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import(${JSON.stringify(distEsm)})`],
      { encoding: "utf8" },
    );
    expect(res.stderr, res.stderr).toBe("");
    expect(res.status).toBe(0);
  });

  it.skipIf(!existsSync(distCjs))("dist/index.cjs requires without throwing", () => {
    const res = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(distCjs)})`],
      { encoding: "utf8" },
    );
    expect(res.stderr, res.stderr).toBe("");
    expect(res.status).toBe(0);
  });
});
