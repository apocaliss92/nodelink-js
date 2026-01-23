export function parseNumber(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseBoolean01(v: string | undefined): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim();
  if (s === "1" || s.toLowerCase() === "true") return true;
  if (s === "0" || s.toLowerCase() === "false") return false;
  return undefined;
}
