import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * jimp must never be reachable from the package barrel at module scope.
 *
 * `PlaceholderRenderer` and the composite-snapshot path in ReolinkBaichuanApi
 * both imported jimp statically, so merely importing this package evaluated it
 * — including for consumers that never render an image.
 *
 * That turned fatal once a consumer bundled us. `@jimp/plugin-print` derives its
 * font directory at module scope from `import.meta.url`, which a bundler inlines
 * as the *build machine's* absolute path. On Windows,
 * `fileURLToPath("file:///Users/...")` throws ERR_INVALID_FILE_URL_PATH:
 * getPathFromURLWin32 requires a drive letter and rejects a POSIX path. The
 * throw aborted the barrel's initialization before `ReolinkBaichuanApi` was
 * assigned, and because a bundler runtime caches the partially-built exports,
 * every later import saw `ReolinkBaichuanApi === undefined`.
 *
 * Downstream that surfaced as "pu is not a constructor" — Windows only, and only
 * from the release that first shipped a static jimp import onward.
 *
 * A unit test cannot catch this: it is a property of the emitted bundle, and on
 * POSIX the offending call succeeds anyway. So assert on the build output.
 */

const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
const dist = (file: string) => join(distDir, file);

/** Static linkage only. A dynamic `import("jimp")` is the fix, not the bug. */
function staticJimpImports(source: string): string[] {
  return [
    // CJS: var import_jimp = require("jimp")
    ...(source.match(/require\(\s*["']jimp[^"']*["']\s*\)/g) ?? []),
    // ESM: import { Jimp } from "jimp"  /  import "jimp/fonts"
    ...(source.match(/(?:^|\n)\s*import\s[^;\n]*from\s*["']jimp[^"']*["']/g) ?? []),
    ...(source.match(/(?:^|\n)\s*import\s*["']jimp[^"']*["']/g) ?? []),
  ].map((s) => s.trim());
}

const entries = ["index.js", "index.cjs"];

describe("package barrel does not eagerly load jimp", () => {
  for (const entry of entries) {
    it(`${entry} has no static jimp import`, () => {
      const path = dist(entry);
      // Guard rather than silently pass on a missing build.
      expect(existsSync(path), `${entry} not built — run npm run build`).toBe(
        true,
      );

      const source = readFileSync(path, "utf8");
      expect(staticJimpImports(source)).toEqual([]);
    });

  }

  it("still reaches jimp lazily somewhere in the build", () => {
    // Complements the checks above: proves jimp was made lazy rather than
    // dropped, so the placeholder and composite-snapshot paths still work.
    // The ESM build code-splits the dynamic import into its own chunk, so this
    // is a whole-dist check rather than a per-entry one.
    const files = readdirSync(distDir, { recursive: true }) as string[];
    const lazy = files.filter((f) => {
      if (!f.endsWith(".js") && !f.endsWith(".cjs")) return false;
      const full = join(distDir, f);
      if (!statSync(full).isFile()) return false;
      return /import\(\s*["']jimp["']\s*\)/.test(readFileSync(full, "utf8"));
    });
    expect(lazy.length).toBeGreaterThan(0);
  });
});

describe("staticJimpImports matcher", () => {
  it("flags the two shapes that caused the outage", () => {
    expect(staticJimpImports('var import_jimp = require("jimp");')).toHaveLength(1);
    expect(
      staticJimpImports('import { Jimp, JimpMime } from "jimp";'),
    ).toHaveLength(1);
    expect(
      staticJimpImports('import { SANS_32_WHITE } from "jimp/fonts";'),
    ).toHaveLength(1);
  });

  it("does not flag a dynamic import", () => {
    expect(staticJimpImports('await import("jimp")')).toEqual([]);
    expect(
      staticJimpImports('Promise.all([import("jimp"), import("jimp/fonts")])'),
    ).toEqual([]);
  });

  it("does not flag unrelated modules whose name merely contains jimp", () => {
    expect(staticJimpImports('import x from "not-jimp-really";')).toEqual([]);
  });
});
