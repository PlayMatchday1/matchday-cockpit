/* CHURN — the model behind /lifecycle/churn (rebuilt 2026-11-09, Figma sl6PTy5LhCVj1gF0HvGmuF 32:3).
 *
 * ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────────────────────────
 * churn_player_field (0264/0265), rebuilt nightly: one row per person × venue with
 *   matches           distinct PLAYED matches on the person's own PLAYER spot, under growth_participation's
 *                     exclusions, MINUS matches they managed (free manager spots are not play — Ryan)
 *   managed           matches they managed there
 *   booking_cents / membership_cents   Finance net (Finance > Revenue's definition) of their booking and
 *                     membership charges up to their last played day; membership split across venues by
 *                     share of matches, so the rows add up exactly
 * The page used to read growth_player_profile and sum the last segment of `ev` as dollars. That segment is
 * the FIELD ID: "spent" was a sum of field ids ($4,136,976 over the default view). Never parse `ev` for money.
 *
 * ── THE SENTENCE ─────────────────────────────────────────────────────────────────────────────
 * "Players who haven't played in [N days] but played since [date] in [city] at [field]."
 *   N        a floor on days gone: last played <= today − N. 180 reads "180+".
 *   since    last played >= since (default Jan 1 of this year).
 *   city     the city of the player's USUAL field (the venue with most of their matches).
 *   field    the player's usual field IS that field, and Matches / Spent count only that field (Miguel).
 * "Haven't played in" is always the player's last match ANYWHERE: someone who left one field for another is
 * not gone.
 *
 * Former staff (player_former_staff, 0266) and deleted accounts are left out before anything is counted. */

export const DAYS_OPTIONS = [30, 60, 90, 120, 180] as const;
export type DaysOption = (typeof DAYS_OPTIONS)[number];
export const DEFAULT_DAYS: DaysOption = 90;
export const daysLabel = (d: number): string => (d >= 180 ? "180+ days" : `${d} days`);
export const defaultSince = (today: string): string => `${today.slice(0, 4)}-01-01`;

export type Tier = "heavy" | "regular" | "tried";
export const TIERS: Tier[] = ["heavy", "regular", "tried"];
export const TIER_NAME: Record<Tier, string> = { heavy: "Heavy", regular: "Regular", tried: "Tried it" };
export const TIER_SUB: Record<Tier, string> = { heavy: "10+ matches", regular: "3 to 9 matches", tried: "1 or 2 matches" };
export const tierOf = (matches: number): Tier => (matches >= 10 ? "heavy" : matches >= 3 ? "regular" : "tried");

/** Days gone shows red past this. */
export const DAYS_RED = 180;
/** "Ex-manager" from this many managed matches. */
export const EX_MANAGER_MIN = 10;

/** One row of churn_player_field. */
export type FieldRow = {
  person_id: number; venue_key: number; venue_label: string; city: string | null;
  matches: number; managed: number; booking_cents: number; membership_cents: number;
  first_played: string | null; last_played: string | null; ever_member: boolean;
};

export type Person = {
  id: number;
  /** Everything, all fields. */
  matches: number; managed: number; spentCents: number;
  /** Last played anywhere (wall-clock day). */
  last: string;
  everMember: boolean;
  usual: { venueKey: number; label: string; city: string | null };
  rows: FieldRow[];
};

const sumSpend = (r: FieldRow) => Number(r.booking_cents) + Number(r.membership_cents);

/** People from their field rows. The usual field is the one with most matches; a tie goes to the more recent. */
export function buildPeople(rows: readonly FieldRow[]): Person[] {
  const by = new Map<number, FieldRow[]>();
  for (const r of rows) (by.get(r.person_id) ?? by.set(r.person_id, []).get(r.person_id)!).push(r);
  const out: Person[] = [];
  for (const [id, rs] of by) {
    let matches = 0, managed = 0, spent = 0, last = "", member = false;
    let usual: FieldRow | null = null;
    for (const r of rs) {
      matches += r.matches; managed += r.managed; spent += sumSpend(r);
      if (r.last_played && r.last_played > last) last = r.last_played;
      if (r.ever_member) member = true;
      if (r.matches > 0 && (!usual || r.matches > usual.matches || (r.matches === usual.matches && (r.last_played ?? "") > (usual.last_played ?? "")))) usual = r;
    }
    if (!usual || matches === 0 || !last) continue; // managed-only people never played
    out.push({ id, matches, managed, spentCents: spent, last, everMember: member,
      usual: { venueKey: usual.venue_key, label: usual.venue_label, city: usual.city }, rows: rs });
  }
  return out;
}

export const daysGone = (last: string, today: string): number =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);

const minusDays = (today: string, n: number): string =>
  new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export type Filter = { days: number; since: string; city: string | null; field: number | null; today: string };

/** A person as the table shows them under the filter: when a field is picked, only that field counts. */
export type Shown = {
  id: number; matches: number; managed: number; spentCents: number; last: string; daysGone: number;
  city: string | null; field: string; fieldKey: number; everMember: boolean; exManager: boolean; tier: Tier;
};

export function applyFilter(people: readonly Person[], f: Filter): Shown[] {
  const floor = minusDays(f.today, f.days);
  const out: Shown[] = [];
  for (const p of people) {
    if (p.last > floor || p.last < f.since) continue;
    if (f.city && p.usual.city !== f.city) continue;
    if (f.field != null && p.usual.venueKey !== f.field) continue;
    let matches = p.matches, spent = p.spentCents;
    if (f.field != null) {
      const r = p.rows.find((x) => x.venue_key === f.field);
      matches = r?.matches ?? 0; spent = r ? sumSpend(r) : 0;
    }
    if (matches <= 0) continue;
    out.push({ id: p.id, matches, managed: p.managed, spentCents: spent, last: p.last, daysGone: daysGone(p.last, f.today),
      city: p.usual.city, field: p.usual.label, fieldKey: p.usual.venueKey, everMember: p.everMember,
      exManager: p.managed >= EX_MANAGER_MIN, tier: tierOf(matches) });
  }
  return out;
}

export function tierCounts(rows: readonly Shown[]): Record<Tier | "all", number> {
  const c = { all: rows.length, heavy: 0, regular: 0, tried: 0 };
  for (const r of rows) c[r.tier]++;
  return c;
}

export const SORT_KEYS = ["name", "city", "field", "matches", "spent", "last", "days"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "matches", dir: "desc" };

export function sortShown<T extends Shown & { name?: string | null }>(rows: T[], key: SortKey, dir: SortDir): T[] {
  const s = dir === "asc" ? 1 : -1;
  const val = (r: T): string | number =>
    key === "name" ? (r.name ?? "").toLowerCase() : key === "city" ? (r.city ?? "") : key === "field" ? r.field.toLowerCase()
      : key === "matches" ? r.matches : key === "spent" ? r.spentCents : key === "last" ? r.last : r.daysGone;
  return rows.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    if (x < y) return -s; if (x > y) return s;
    return b.matches - a.matches || a.id - b.id;
  });
}

/* ── WIN-BACK ───────────────────────────────────────────────────────────────────────────────── */

export type Winback = { state: "none" } | { state: "messaged"; at: string } | { state: "came_back"; at: string };

/* ── THE TABLE AND THE CSV ARE ONE LIST OF COLUMNS ───────────────────────────────────────────── */

export type Display = Shown & { name: string | null; phone: string | null; winback: Winback };

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Jun 30, 2026" from a YYYY-MM-DD day (never through Date: a day is a day). */
export const dayLabel = (d: string): string => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
/** "Nov 3" from an ISO instant, in Central time. */
export const shortChicago = (iso: string): string => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }).format(new Date(iso));
  return p;
};
export const winbackText = (w: Winback): string =>
  w.state === "messaged" ? `Messaged ${shortChicago(w.at)}` : w.state === "came_back" ? "Came back" : "";

export type Column = { key: string; label: string; cell: (r: Display, cityName: (c: string | null) => string) => string };

/** The columns, in order. The page renders these headers; the CSV writes exactly these cells. */
export function columns(fieldScoped: boolean): Column[] {
  return [
    { key: "player", label: "Player", cell: (r) => r.name ?? `Player ${r.id}` },
    { key: "phone", label: "Phone", cell: (r) => r.phone ?? "" },
    { key: "tags", label: "Tags", cell: (r) => [r.everMember ? "Ex-member" : "", r.exManager ? "Ex-manager" : ""].filter(Boolean).join(" ") },
    { key: "city", label: "City", cell: (r, cn) => cn(r.city) },
    { key: "field", label: "Usual field", cell: (r) => r.field },
    { key: "matches", label: fieldScoped ? "Matches here" : "Matches", cell: (r) => String(r.matches) },
    { key: "spent", label: fieldScoped ? "Spent here" : "Spent", cell: (r) => money(r.spentCents) },
    { key: "last", label: "Last played", cell: (r) => dayLabel(r.last) },
    { key: "days", label: "Days gone", cell: (r) => String(r.daysGone) },
    { key: "winback", label: "Win-back", cell: (r) => winbackText(r.winback) },
  ];
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function toCsv(rows: readonly Display[], fieldScoped: boolean, cityName: (c: string | null) => string): string {
  const cols = columns(fieldScoped);
  const lines = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c.cell(r, cityName))).join(","));
  return lines.join("\n") + "\n";
}

/** A deleted account's email is rewritten to del_<hash>@playmatchday.com; there is nobody to win back. */
export const isScrubbed = (email: string | null | undefined): boolean =>
  /^del_[0-9a-f]+@playmatchday\.com$/i.test(String(email ?? "").trim());
