// City Manager Check-Ins data layer.
//
// Reads `city_manager_check_ins` (migration 0167). Submissions come from the public /check-in page
// via the guarded /api/city-check-ins/submit route — the same shape Equipment Inventory uses.
//
// WAS: the published Google Sheet CSV. That pipeline is gone, and with it three helpers that only
// existed to survive free text — a keyword-matching column finder, a fuzzy city matcher with a
// special case for OKC, and the publish URL. The city is now stored as a `city_identifier`, so
// MANAGERS[].cityId matches it with `===` and there is nothing left to guess.

import { cityNameFor } from "./cityScope";

export type Manager = {
  name: string;
  city: string; // Sheet/standalone label (e.g. "North Austin", "DFW", "St Louis")
  /** city_identifier (cityScope.ts) — the key anything joining to this manager must use. */
  cityId: string;
  payDay: number; // day of month
  amount: number; // monthly $
};

// 7 city managers. Mirror this when the form/Sheet manager universe
// changes — the Sheet is read live for check-in submissions, but this
// list drives the calendar rows, payment cards, and the one-card-per-
// manager grid. Array order = calendar row order (top to bottom) and
// the tie-break order within a shared pay day on the payment cards.
/* NAMES AND SPELLINGS TAKEN FROM THE REAL DATA, not from a mockup. The check-in Sheet carried NO
 * name column — only a city and an email — so these were resolved by joining the submitting emails
 * to app_users where is_city_manager is true. Two were misspelt here: "Yarra" is Yara Usheta and
 * "Willfried" is Wilfried Nyamsi.
 *
 * THAT RECONSTRUCTION IS NO LONGER NECESSARY FOR NEW ROWS. The /check-in form asks for the name
 * directly and stores it in city_manager_check_ins.manager_name, which is exactly why it asks.
 * This array still has to be maintained by hand because it carries payDay and amount, which the
 * form does not collect — moving it to a table is a separate job.
 *
 * `cityId` is the city_identifier (src/lib/cityScope.ts) and it is what the meeting action items
 * are keyed on. The `city` string above it is the loose label the SHEET matcher needs, and the two
 * must not be conflated: the repo already spells one city three ways ("DFW" here, "Dallas" in
 * types.CITIES, "Dallas-Fort Worth" in the goals export), which is exactly why anything that has to
 * JOIN uses the identifier.
 *
 * ATLANTA IS BEN FAYE, added 2026-09-09 on Ryan's word. It was absent before, deliberately: it had
 * goals in the September export but no manager, and the mock guessed a name for it rather than
 * leaving the gap visible.
 *
 * HE READ AS "NOT SUBMITTED" BECAUSE ATLANTA HAD NEVER FILED — the Sheet carried no Atlanta row at
 * all. Measured on the published CSV, 2026-09-09 and again on 2026-09-11 at the import: twelve
 * submissions spelling five cities, San Antonio, Austin, DFW, Houston and Oklahoma City.
 *
 * He can file now. /check-in offers every city in cityScope.ts — not the cities in this array — so
 * a city can submit before anyone remembers to add its manager here, and ATL matches on `cityId`
 * the moment a row lands. The `city` string below is a display label only; nothing matches on it.
 *
 * payDay 25 NEEDS NO CODE CHANGE. getNextPayDate clamps with Math.min against daysInMonth on both
 * branches, so a 25th is safe in February and any other short month. */
export const MANAGERS: Manager[] = [
  { name: "Yara Usheta", city: "Houston", cityId: "HOU", payDay: 1, amount: 500 },
  { name: "Garrett Suits", city: "Austin", cityId: "ATX", payDay: 1, amount: 500 },
  { name: "Rodrigo", city: "OKC", cityId: "OKC", payDay: 1, amount: 500 },
  { name: "Wilfried Nyamsi", city: "St Louis", cityId: "STL", payDay: 1, amount: 500 },
  { name: "Chris Padilla", city: "DFW", cityId: "DFW", payDay: 15, amount: 800 },
  { name: "Abraham Garcia", city: "San Antonio", cityId: "SATX", payDay: 15, amount: 500 },
  { name: "Ben Faye", city: "Atlanta", cityId: "ATL", payDay: 25, amount: 500 },
];

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// Next pay date relative to `today` — this month's pay day if it
// hasn't passed, otherwise next month's. Clamps the day to the
// month's actual length (e.g. payDay=31 in February → Feb 28).
export function getNextPayDate(payDay: number, today: Date): Date {
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayThisMonth = Math.min(payDay, daysInMonth(today.getFullYear(), today.getMonth()));
  const thisMonthPay = new Date(today.getFullYear(), today.getMonth(), dayThisMonth);
  if (thisMonthPay >= todayMid) return thisMonthPay;
  const nextMonth = today.getMonth() === 11 ? 0 : today.getMonth() + 1;
  const nextYear = today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
  const dayNextMonth = Math.min(payDay, daysInMonth(nextYear, nextMonth));
  return new Date(nextYear, nextMonth, dayNextMonth);
}

export function daysUntil(date: Date, today: Date): number {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((d.getTime() - t.getTime()) / (1000 * 60 * 60 * 24));
}

export function formatMonthDay(d: Date): string {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

export function formatMoney(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

export type CheckInEntry = {
  timestamp: Date;
  city: string; // display name resolved from city_identifier (cityScope.ts)
  rating: number; // parsed; 0 if missing or invalid
  win: string;
  challenge: string;
  focus: string;
  fieldsContacted: string;
  fieldsList: string;
  fieldProgress: string;
  matchManager: string;
  marketingChannels: string;
  marketingResults: string;
};

export type ManagerStatus = {
  manager: Manager;
  entry: CheckInEntry | null; // latest submission ever, regardless of month
  submitted: boolean; // entry exists AND timestamp >= 1st of current calendar month
};

export type CheckInsData = {
  statuses: ManagerStatus[];
  submittedCount: number;
  overdueCount: number; // = total − submitted (matches standalone semantics)
};

/* ONE STORED CHECK-IN, as `city_manager_check_ins` holds it. snake_case deliberately: this is the
 * row, not the view model, and CheckInEntry below is the shape the page consumes. */
export type CheckInRecord = {
  submitted_at: string;
  manager_name: string;
  city_identifier: string;
  month_ending: string; // YYYY-MM-DD
  rating: number | null;
  fields_contacted: string | null;
  fields_list: string | null;
  field_progress: string | null;
  match_manager: string | null;
  marketing_channels: string | null;
  marketing_results: string | null;
  win: string | null;
  challenge: string | null;
  focus: string | null;
};

const SELECT_COLS =
  "submitted_at, manager_name, city_identifier, month_ending, rating, fields_contacted, " +
  "fields_list, field_progress, match_manager, marketing_channels, marketing_results, " +
  "win, challenge, focus";

/* THE SUPABASE CLIENT IS IMPORTED LAZILY, INSIDE THE FUNCTION. src/lib/supabase.ts is a
 * "use client" module, and this file also exports daysInMonth, which opexSources.ts imports on
 * paths that are not client-only. A top-level import would drag the browser client into those
 * bundles for a date helper. */
export async function fetchCheckIns(month?: string): Promise<CheckInsData> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase
    .from("city_manager_check_ins")
    .select(SELECT_COLS)
    .order("submitted_at", { ascending: false });
  /* A FAILED READ THROWS RATHER THAN RETURNING ZERO ROWS. CheckInsView renders the error as "the
   * check-ins could not be loaded — this is not 'nobody submitted'", and that distinction only
   * survives if the error reaches it. An empty array here would paint every manager Overdue. */
  if (error) throw new Error(error.message);
  return buildCheckInsData((data ?? []) as unknown as CheckInRecord[], new Date(), month);
}

/* WHICH MONTH A CHECK-IN IS ABOUT — the month-ending date the manager picked, not the timestamp
 * the form recorded. They are routinely different and the difference is not noise: of the twelve
 * imported submissions, one filed on 17 April reports month-ending 31 March, and one filed on
 * 20 February reports month-ending 3 March. Bucketing those by the filing date would file March's
 * check-in under April.
 *
 * SLICED, NOT PARSED. month_ending is a DATE, not a moment. `new Date("2026-03-31")` is UTC
 * midnight, which in every US timezone is 30 March locally — reading the month off that lands a
 * month-end check-in in the previous month roughly half the time. The string already starts with
 * exactly the YYYY-MM this returns.
 *
 * The column is NOT NULL, so the old fall-back-to-timestamp branch has no case left to cover. */
export function checkInMonth(monthEnding: string): string {
  return String(monthEnding ?? "").slice(0, 7);
}

// Pure transformer split out for testability and so the hook can inject a fake `now` if needed.
export function buildCheckInsData(
  rows: CheckInRecord[],
  now: Date,
  month?: string,
): CheckInsData {
  /* LATEST SUBMISSION PER CITY, WITHIN THE MONTH BEING VIEWED.
   *
   * Keyed on city_identifier and compared to MANAGERS[].cityId with `===`. This is the whole point
   * of the migration off the Sheet: the old path matched a typed city string against a display
   * label through a fuzzy matcher that needed a DFW rule, an OKC rule and an includes() fallback.
   *
   * `month` undefined keeps the original behaviour exactly — latest ever, regardless of month — so
   * every existing caller is unchanged. With a month, a city that filed nothing that month shows
   * nothing, which is the honest answer: the alternative is July's check-in rendered under a
   * September heading. */
  type Acc = { ts: Date; row: CheckInRecord };
  const latestByCity = new Map<string, Acc>();
  for (const row of rows) {
    const ts = new Date(row.submitted_at);
    if (Number.isNaN(ts.getTime())) continue;
    if (month && checkInMonth(row.month_ending) !== month) continue;
    const cur = latestByCity.get(row.city_identifier);
    if (!cur || ts > cur.ts) latestByCity.set(row.city_identifier, { ts, row });
  }

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const statuses: ManagerStatus[] = MANAGERS.map((m) => {
    const match = latestByCity.get(m.cityId) ?? null;
    if (!match) return { manager: m, entry: null, submitted: false };
    const r = match.row;
    const text = (v: string | null) => (v ?? "").trim();
    const rating = Number(r.rating);
    const entry: CheckInEntry = {
      timestamp: match.ts,
      city: cityNameFor(r.city_identifier) ?? r.city_identifier,
      rating: Number.isFinite(rating) ? rating : 0,
      win: text(r.win),
      challenge: text(r.challenge),
      focus: text(r.focus),
      fieldsContacted: text(r.fields_contacted),
      fieldsList: text(r.fields_list),
      fieldProgress: text(r.field_progress),
      matchManager: text(r.match_manager),
      marketingChannels: text(r.marketing_channels),
      marketingResults: text(r.marketing_results),
    };
    /* WITH A MONTH, THE ROWS ARE ALREADY THAT MONTH'S, so an entry existing IS a submission —
     * comparing its timestamp to THIS month's start would mark every on-time August check-in
     * "Overdue" the moment you stepped back to look at August. Without a month the original rule
     * stands untouched: latest ever, submitted only if it landed this calendar month. */
    return { manager: m, entry, submitted: month ? true : match.ts >= monthStart };
  });

  const submittedCount = statuses.filter((s) => s.submitted).length;
  return {
    statuses,
    submittedCount,
    overdueCount: statuses.length - submittedCount,
  };
}
