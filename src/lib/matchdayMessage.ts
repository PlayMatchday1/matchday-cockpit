// MATCHDAY'S OWN WORDS FROM A REFUSAL (Ryan, 2026-11-07). A rejected write carries the first 200
// characters of MatchDay's body (WriteFailedError.bodySnippet). The usual shape is JSON with
// `message` (a string, or a list of strings from validation) or `error`; anything else that is short
// plain text is returned as-is; HTML or nothing is null. PURE.

export function matchdayMessage(snippet: string | null | undefined): string | null {
  const s = (snippet ?? "").trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const m = j.message ?? j.error;
    if (Array.isArray(m)) { const t = m.filter((x) => typeof x === "string").join("; ").trim(); return t || null; }
    if (typeof m === "string" && m.trim()) return m.trim();
    return null;
  } catch {
    return s.startsWith("<") ? null : s.slice(0, 200);
  }
}
