// Player Lookup (Phase 18) — the pure, testable core: what did the operator type,
// and where should a new player go. No React, no fetch — so scripts/player-lookup-
// model-test.ts can pin the detection and the add-suggestion without a browser.
//
// Search detection mirrors the real API: /admin/players?email=<term> is a UNIVERSAL
// fuzzy match (it hits email, name AND phone-digits — confirmed live), and ?id=<n>
// is exact. So the KIND we detect drives the HINT and whether a single hit goes
// straight through; the server turns everything except a pure id into ?email.

export type SearchKind = "empty" | "email" | "phone" | "id" | "name";

export type Detected = { kind: SearchKind; norm: string };

// A bare 1-6 digit number is far more likely a player ID than a phone; 7+ digits is
// a phone (digits only, so formatting never matters). An @ is unambiguously an email.
export function detectKind(raw: string): Detected {
  const q = (raw ?? "").trim();
  if (!q) return { kind: "empty", norm: "" };
  if (q.includes("@")) return { kind: "email", norm: q.toLowerCase() };
  const digits = q.replace(/[^\d]/g, "");
  if (/^\d{1,6}$/.test(q)) return { kind: "id", norm: q };
  if (digits.length >= 7) return { kind: "phone", norm: digits };
  return { kind: "name", norm: q.toLowerCase() };
}

export const SEARCH_HINT: Record<SearchKind, string> = {
  empty: "Type anything — it works out whether you gave it a phone number, an email, an ID or a name.",
  email: "Reading that as an email address.",
  phone: "Reading that as a phone number — digits only, so formatting does not matter.",
  id: "Reading that as a player ID. Add a country code or dashes if you meant a phone number.",
  name: "Reading that as a name.",
};

// The query the server should send for a detected term: pure id -> exact ?id; a phone
// -> digits into the fuzzy ?email; everything else -> raw into ?email.
export function serverQuery(d: Detected): Record<string, string> {
  if (d.kind === "id") return { id: d.norm };
  if (d.kind === "phone") return { email: d.norm };
  return { email: d.norm };
}

export function money(cents: number | null | undefined): string {
  const c = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return "$" + (c / 100).toFixed(2);
}

// ---- add-to-match spot suggestion -------------------------------------------
// A team is {size, taken:number[]}. Open spots are 1..size minus taken.
export type SpotTeam = { size: number; taken: number[] };

export function openSpots(t: SpotTeam): number[] {
  const taken = new Set(t.taken ?? []);
  const out: number[] = [];
  for (let n = 1; n <= (t.size ?? 0); n++) if (!taken.has(n)) out.push(n);
  return out;
}

export function matchOpen(teams: SpotTeam[]): number {
  return (teams ?? []).reduce((n, t) => n + openSpots(t).length, 0);
}

// Suggest the EMPTIER side, then its lowest free number. Balancing sides matters more
// than filling the first gap — an 8v2 is a worse match than a 6v4, so balance before
// fill. Returns null when the match is full.
export function suggestSpot(teams: SpotTeam[]): { team: number; spot: number } | null {
  const cands = (teams ?? [])
    .map((t, i) => ({ i, taken: (t.taken ?? []).length, free: openSpots(t) }))
    .filter((x) => x.free.length > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => a.taken - b.taken || a.i - b.i);
  return { team: cands[0].i, spot: cands[0].free[0] };
}
