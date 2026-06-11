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
//
// Loading the module alone is not enough: `const { mulaw } = alawmulaw;`
// silently assigns `undefined`, and the crash only happens when `mulaw.decode`
// is called. So we actually invoke `mulawToPcm16` / `alawToPcm16` on real
// bytes inside a subprocess and assert decoded length and sane values.
describe("built bundle loads under real Node ESM/CJS interop", () => {
  // Cold Node subprocess + full ESM/CJS import of a 5MB bundle is slow on
  // disk-pressured CI runners (regularly 8-15s). The default 10s test
  // timeout occasionally fires for no good reason; 60s is comfortably
  // above the long tail.
  const longTimeoutMs = 60_000;

  it.skipIf(!existsSync(distEsm))("dist/index.js imports without throwing", () => {
    const res = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import(${JSON.stringify(distEsm)})`],
      { encoding: "utf8" },
    );
    expect(res.stderr, res.stderr).toBe("");
    expect(res.status).toBe(0);
  }, longTimeoutMs);

  it.skipIf(!existsSync(distCjs))("dist/index.cjs requires without throwing", () => {
    const res = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(distCjs)})`],
      { encoding: "utf8" },
    );
    expect(res.stderr, res.stderr).toBe("");
    expect(res.status).toBe(0);
  }, longTimeoutMs);

  // Build a tiny PCMU/PCMA buffer and decode it through the bundled
  // exports. This is the actual codepath Frigate's RTP backchannel hits;
  // when alawmulaw isn't resolved correctly the decoder throws
  // "Cannot read properties of undefined (reading 'decode')".
  const decodeScript = (importExpr: string) => `
    const mod = await ${importExpr};
    const bytes = new Uint8Array([0xff, 0x7f, 0x55, 0xaa, 0x00, 0x80, 0xfe, 0x7e]);
    const mulaw = mod.mulawToPcm16(bytes);
    const alaw = mod.alawToPcm16(bytes);
    if (!(mulaw instanceof Int16Array) || mulaw.length !== bytes.length) {
      throw new Error("mulawToPcm16 returned wrong shape: " + JSON.stringify({
        ctor: mulaw && mulaw.constructor && mulaw.constructor.name,
        len: mulaw && mulaw.length,
      }));
    }
    if (!(alaw instanceof Int16Array) || alaw.length !== bytes.length) {
      throw new Error("alawToPcm16 returned wrong shape");
    }
    // PCMU silence byte 0xff decodes to 0; assert at least one non-zero
    // sample so we know we ran the real codec, not a stub.
    const anyNonZero = Array.from(mulaw).some((s) => s !== 0)
      || Array.from(alaw).some((s) => s !== 0);
    if (!anyNonZero) throw new Error("decoded buffer was all zeros");
    process.stdout.write("ok");
  `;

  it.skipIf(!existsSync(distEsm))("dist/index.js decodes PCMU/PCMA in real Node ESM", () => {
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        decodeScript(`import(${JSON.stringify(distEsm)})`),
      ],
      { encoding: "utf8" },
    );
    expect(res.stderr, res.stderr).toBe("");
    expect(res.stdout).toBe("ok");
    expect(res.status).toBe(0);
  });

  it.skipIf(!existsSync(distCjs))("dist/index.cjs decodes PCMU/PCMA in real Node CJS", () => {
    const res = spawnSync(
      process.execPath,
      [
        "-e",
        `(async () => { ${decodeScript(`Promise.resolve(require(${JSON.stringify(distCjs)}))`)} })().catch((e) => { console.error(e); process.exit(1); });`,
      ],
      { encoding: "utf8" },
    );
    expect(res.stderr, res.stderr).toBe("");
    expect(res.stdout).toBe("ok");
    expect(res.status).toBe(0);
  });
});
