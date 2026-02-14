import path from "node:path";
import fs from "node:fs";

/**
 * Infer GitHub repo slug (owner/repo) from env or package.json.
 */
export function inferGithubRepoSlug(): string | null {
  const explicit =
    process.env.GITHUB_REPO ||
    process.env.UPDATE_REPO ||
    process.env.GITHUB_REPOSITORY;
  if (explicit && explicit.trim()) return explicit.trim();

  const candidates = [
    path.resolve(process.cwd(), "package.json"),
    path.resolve(process.cwd(), "app/package.json"),
    path.resolve(process.cwd(), "../package.json"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as {
        repository?: { url?: string } | string;
      };
      const repoUrl =
        typeof parsed.repository === "string"
          ? parsed.repository
          : parsed.repository?.url;
      if (!repoUrl) continue;

      const cleaned = String(repoUrl)
        .replace(/^git\+/, "")
        .replace(/\.git$/i, "");

      const httpsMatch = cleaned.match(/github\.com\/(.+\/[^/]+)$/i);
      if (httpsMatch?.[1]) return httpsMatch[1];

      const sshMatch = cleaned.match(/github\.com[:/](.+\/[^/]+)$/i);
      if (sshMatch?.[1]) return sshMatch[1];
    } catch {
      // ignore
    }
  }

  return null;
}
