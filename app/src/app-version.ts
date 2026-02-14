import path from "node:path";
import fs from "node:fs";

/**
 * Read app version from package.json (nodelink-manager or fallback).
 */
export function readAppVersion(): string | null {
  if (process.env.APP_VERSION && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim();
  }

  const candidates = [
    path.resolve(process.cwd(), "package.json"),
    path.resolve(process.cwd(), "app/package.json"),
    path.resolve(process.cwd(), "../package.json"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (
        parsed?.name === "nodelink-manager" &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    } catch {
      // ignore
    }
  }

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // ignore
    }
  }

  return null;
}
