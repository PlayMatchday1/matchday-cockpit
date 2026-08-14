// THE CITY SCOPE LIST — the one place a city manager's `city_identifier` may come from.
//
// WHY A LIST AT ALL. Migration 0120 deliberately put NO check constraint on city_identifier ("a
// CHECK listing today's seven abbreviations is a migration every time a city opens"). That was the
// right call for the database and the wrong thing to leave as the ONLY protection, because the
// column is free text: a typed `dfw`, `DFW ` or `Dallas` scopes an account to nothing at all and
// renders identically to a correct value in the grid. Every query pushes
// `.eq("city_identifier", …)`, so a near-miss is not an error — it is a silent empty page. That is
// precisely why the tier was never grantable from the UI.
//
// So the allowlist lives HERE, in code, enforced by the route: adding a city is a one-line edit
// rather than a migration, and a bad value is refused with a message instead of stored.
//
// SOURCE. These are the exact (city_identifier, city_name) pairs mdapi_matches carries — the same
// values Gameday Ops builds its city chips from, and the same values every scoped query compares
// against. Verified against production on 2026-08-14 over 1,000 matches since 2026-01-01:
//   ATX 495 · SATX 218 · HOU 128 · ATL 53 · STL 51 · DFW 50 · OKC 5
// scripts/city-scope-test.ts pins the pairs so a rename upstream fails a test rather than silently
// unscoping somebody.

export type CityScope = { identifier: string; name: string };

export const CITY_SCOPES: readonly CityScope[] = [
  { identifier: "ATL", name: "Atlanta" },
  { identifier: "ATX", name: "Austin" },
  { identifier: "DFW", name: "Dallas / Fort Worth" },
  { identifier: "HOU", name: "Houston" },
  { identifier: "OKC", name: "Oklahoma City" },
  { identifier: "SATX", name: "San Antonio" },
  { identifier: "STL", name: "St. Louis" },
] as const;

export const CITY_IDENTIFIERS: readonly string[] = CITY_SCOPES.map((c) => c.identifier);

// EXACT match only. No trimming, no upper-casing, no "did you mean" — a value that needs
// correcting is a value someone typed, and this path exists so that nobody types one. Returning
// the canonical row (rather than a boolean) means callers store what the list says, never the
// input string.
export function resolveCityScope(raw: unknown): CityScope | null {
  if (typeof raw !== "string") return null;
  return CITY_SCOPES.find((c) => c.identifier === raw) ?? null;
}

export function cityNameFor(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  return CITY_SCOPES.find((c) => c.identifier === identifier)?.name ?? null;
}

// A stored value that is NOT in the list — an account scoped by an older SQL grant, or by hand.
// It is shown as such in the grid rather than rendered as if it were fine: this account's pages
// are empty and nobody would otherwise know why.
export function isUnknownScope(identifier: string | null | undefined): boolean {
  return !!identifier && cityNameFor(identifier) == null;
}
