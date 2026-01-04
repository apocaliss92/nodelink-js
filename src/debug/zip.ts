import * as fs from "node:fs";
import * as path from "node:path";

import yazl from "yazl";

async function walkDir(rootDir: string, currentDir: string): Promise<Array<{ absPath: string; relPath: string; isDir: boolean }>> {
  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  const out: Array<{ absPath: string; relPath: string; isDir: boolean }> = [];

  for (const ent of entries) {
    const absPath = path.join(currentDir, ent.name);
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");

    if (ent.isDirectory()) {
      out.push({ absPath, relPath, isDir: true });
      out.push(...(await walkDir(rootDir, absPath)));
      continue;
    }

    if (ent.isFile()) {
      out.push({ absPath, relPath, isDir: false });
      continue;
    }

    // Ignore symlinks/sockets/etc for diagnostics bundles.
  }

  return out;
}

export async function zipDirectory(params: { sourceDir: string; zipPath: string }): Promise<void> {
  const { sourceDir, zipPath } = params;

  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });

  const zipFile = new yazl.ZipFile();

  const entries = await walkDir(sourceDir, sourceDir);
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  // Add directories first (best-effort; zip doesn't strictly require it).
  for (const d of dirs) {
    // yazl expects directories with trailing slash
    const name = d.relPath.endsWith("/") ? d.relPath : d.relPath + "/";
    zipFile.addEmptyDirectory(name);
  }

  for (const f of files) {
    zipFile.addFile(f.absPath, f.relPath);
  }

  const out = fs.createWriteStream(zipPath);

  await new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    zipFile.outputStream.on("error", reject);
    out.on("close", resolve);

    zipFile.outputStream.pipe(out);
    zipFile.end();
  });
}
