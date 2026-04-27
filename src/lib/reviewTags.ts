// Parse + classify tags_rating values. The raw column comes from the CSV as
// either comma-separated text, a JSON array string, or a Postgres array
// literal — handle all three.

export type TagCategory = "positive" | "negative" | "neutral";

const POSITIVE_PATTERNS = [
  "QUALITY",
  "GOOD",
  "GREAT",
  "COMPETITIVE",
  "FRIENDLY",
  "FAIR",
  "FUN",
  "PROFESSIONAL",
  "ON TIME",
];

// Negative patterns are checked FIRST so "UNFAIR" doesn't get caught by the
// positive "FAIR" substring.
const NEGATIVE_PATTERNS = [
  "POOR",
  "BAD",
  "UNORGANIZED",
  "LATE",
  "RUDE",
  "UNFAIR",
  "UNSAFE",
];

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const t = String(raw).trim();
  if (!t) return [];

  // JSON array: ["foo","bar"]
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => String(x).trim())
          .filter((x) => x.length > 0);
      }
    } catch {
      // fall through to other parsers
    }
  }

  // Postgres array literal: {foo,bar,"baz qux"}
  if (t.startsWith("{") && t.endsWith("}")) {
    return t
      .slice(1, -1)
      .split(",")
      .map((s) => s.replace(/^"|"$/g, "").trim())
      .filter((s) => s.length > 0);
  }

  // Fallback: split on " - " (the actual separator in the user-analysis CSV)
  // OR comma. The whitespace requirement around the dash is what
  // distinguishes a separator from a hyphen inside a tag name like
  // "ON-TIME START AND FINISH" — that one stays intact as a single tag.
  return t
    .split(/\s-\s|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function classifyTag(tag: string): TagCategory {
  const u = tag.toUpperCase();
  for (const p of NEGATIVE_PATTERNS) {
    if (u.includes(p)) return "negative";
  }
  for (const p of POSITIVE_PATTERNS) {
    if (u.includes(p)) return "positive";
  }
  return "neutral";
}
