export const isReolinkUidLike = (value: string): boolean => {
  const s = value.trim();
  return /^[0-9A-Z]{12,24}$/.test(s) && /[A-Z]/.test(s);
};

export const extractReolinkUidLike = (value: unknown): string | undefined => {
  const seen = new Set<unknown>();

  const walk = (v: unknown): string | undefined => {
    if (v == null) return undefined;

    if (typeof v === "string") {
      const s = v.trim();
      if (isReolinkUidLike(s)) return s;

      // Best-effort scan for UID-like substrings (useful for XML payloads).
      const m = s.match(/\b[0-9A-Z]{12,24}\b/);
      if (m?.[0] && isReolinkUidLike(m[0])) return m[0];
      return undefined;
    }

    if (typeof v !== "object") return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const it of v) {
        const r = walk(it);
        if (r) return r;
      }
      return undefined;
    }

    for (const vv of Object.values(v as Record<string, unknown>)) {
      const r = walk(vv);
      if (r) return r;
    }

    return undefined;
  };

  return walk(value);
};
