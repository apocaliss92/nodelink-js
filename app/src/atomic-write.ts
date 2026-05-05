import fs from "node:fs";
import path from "node:path";

/**
 * Atomically write a file by writing to a temporary sibling and renaming.
 *
 * Why: `fs.writeFileSync(target, ...)` opens with O_TRUNC + O_WRONLY and writes
 * in place. If the process is killed between the truncate and the write
 * (`docker stop`, OOM, host reboot) the file is left at 0 bytes. `rename(2)`
 * is atomic on POSIX within the same filesystem, so a crash either leaves the
 * old file or the new file — never a truncated one.
 *
 * If `keepBackup` is true and the target exists, the previous version is
 * copied to `${target}.bak` before the rename so a corrupted target can be
 * recovered on the next load.
 */
export function atomicWriteFileSync(
  target: string,
  content: string | Uint8Array,
  options: { keepBackup?: boolean; mode?: number } = {},
): void {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w", options.mode ?? 0o644);
    if (typeof content === "string") {
      fs.writeSync(fd, content);
    } else {
      fs.writeSync(fd, content, 0, content.byteLength, 0);
    }
    // Force data to disk before the rename so a power loss after rename
    // cannot leave a zero-length file under the target name.
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }

  try {
    fs.closeSync(fd);
  } catch { /* ignore */ }

  if (options.keepBackup && fs.existsSync(target)) {
    try {
      fs.copyFileSync(target, `${target}.bak`);
    } catch {
      // Backup is best-effort; never fail the primary write because of it.
    }
  }

  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Read a file, falling back to its `.bak` sibling if the primary is missing,
 * empty, or unreadable. Returns `null` if no readable copy exists.
 *
 * The caller is responsible for parsing/validating the returned content.
 */
export function readWithBackupFallback(target: string): string | null {
  const candidates = [target, `${target}.bak`];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.statSync(candidate);
      if (stat.size === 0) continue;
      return fs.readFileSync(candidate, "utf-8");
    } catch {
      // try next candidate
    }
  }
  return null;
}
