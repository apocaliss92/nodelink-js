import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  atomicWriteFileSync,
  readWithBackupFallback,
} from "../../app/src/atomic-write.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("atomicWriteFileSync", () => {
  it("writes content to the target file", () => {
    const target = path.join(tmpDir, "settings.json");
    atomicWriteFileSync(target, '{"hello":"world"}');
    expect(fs.readFileSync(target, "utf-8")).toBe('{"hello":"world"}');
  });

  it("does not leave a temp file behind on success", () => {
    const target = path.join(tmpDir, "settings.json");
    atomicWriteFileSync(target, '{"a":1}');
    const stray = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith(".settings.json.tmp"));
    expect(stray).toEqual([]);
  });

  it("overwrites an existing file with new content", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, '{"old":true}');
    atomicWriteFileSync(target, '{"new":true}');
    expect(fs.readFileSync(target, "utf-8")).toBe('{"new":true}');
  });

  it("creates a .bak copy of the previous version when keepBackup is set", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, '{"old":true}');
    atomicWriteFileSync(target, '{"new":true}', { keepBackup: true });
    expect(fs.readFileSync(target, "utf-8")).toBe('{"new":true}');
    expect(fs.readFileSync(`${target}.bak`, "utf-8")).toBe('{"old":true}');
  });

  it("does not create a .bak when target does not exist yet", () => {
    const target = path.join(tmpDir, "settings.json");
    atomicWriteFileSync(target, '{"first":true}', { keepBackup: true });
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });

  it("never leaves the target at zero bytes after a successful write", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, '{"prev":true}');
    atomicWriteFileSync(target, '{"v":2}', { keepBackup: true });
    expect(fs.statSync(target).size).toBeGreaterThan(0);
  });

  it("cleans up the temp file if the rename fails", () => {
    // Force rename to fail by passing a target whose parent does not exist.
    const target = path.join(tmpDir, "missing-dir", "settings.json");
    expect(() => atomicWriteFileSync(target, '{"x":1}')).toThrow();
    // No temp file should remain in tmpDir/missing-dir (which itself shouldn't exist).
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it("supports binary (Uint8Array) payloads", () => {
    const target = path.join(tmpDir, "blob.bin");
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    atomicWriteFileSync(target, payload);
    const read = fs.readFileSync(target);
    expect(Array.from(read)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
});

describe("readWithBackupFallback", () => {
  it("returns the primary file content when present", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, "primary");
    expect(readWithBackupFallback(target)).toBe("primary");
  });

  it("falls back to .bak when the primary file is empty (the issue #17 case)", () => {
    const target = path.join(tmpDir, "settings.json");
    // Simulate the truncated-but-not-written state caused by docker stop
    // landing between O_TRUNC and write().
    fs.writeFileSync(target, "");
    fs.writeFileSync(`${target}.bak`, "recovered");
    expect(readWithBackupFallback(target)).toBe("recovered");
  });

  it("falls back to .bak when the primary file is missing", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(`${target}.bak`, "recovered");
    expect(readWithBackupFallback(target)).toBe("recovered");
  });

  it("returns null when neither primary nor .bak is readable", () => {
    const target = path.join(tmpDir, "settings.json");
    expect(readWithBackupFallback(target)).toBeNull();
  });

  it("ignores an empty .bak and returns null", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, "");
    fs.writeFileSync(`${target}.bak`, "");
    expect(readWithBackupFallback(target)).toBeNull();
  });
});
