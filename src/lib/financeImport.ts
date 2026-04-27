import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { normalizeMatchName } from "./venueNormalization";

export type ImportResult = { count: number; note?: string };

const MEMBER_CITY_PREFIX: Record<string, string> = {
  ATX: "Austin",
  DFW: "Dallas",
  HOU: "Houston",
  SATX: "San Antonio",
  ATL: "Atlanta",
  STL: "St. Louis",
  OKC: "OKC",
  ELP: "El Paso",
};

const MONTH_KEYS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const MONTH_LABELS = [
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
const DEFAULT_YEAR = "2026";

// ===== Value parsers =====

function trim(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}

function parseNum(v: string | undefined | null): number | null {
  const t = trim(v);
  if (!t || t === "-" || t === "—") return null;
  let cleaned = t.replace(/[$,\s]/g, "");
  cleaned = cleaned.replace(/^\(([\d.]+)\)$/, "-$1");
  if (cleaned === "" || cleaned === "-") return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function parseInteger(v: string | undefined | null): number | null {
  const n = parseNum(v);
  if (n === null) return null;
  return Math.round(n);
}

function parseBool(v: string | undefined | null, defaultValue: boolean): boolean {
  const t = trim(v);
  if (!t) return defaultValue;
  const lower = t.toLowerCase();
  if (["true", "yes", "1", "y", "active"].includes(lower)) return true;
  if (["false", "no", "0", "n", "inactive"].includes(lower)) return false;
  return defaultValue;
}

function parseDate(v: string | undefined | null): string | null {
  const t = trim(v);
  if (!t || t === "-" || t === "—") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const us4 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us4) {
    const [, m, d, y] = us4;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const us2 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (us2) {
    const [, m, d, y] = us2;
    const yr = parseInt(y, 10);
    const fullYear = yr < 50 ? 2000 + yr : 1900 + yr;
    return `${fullYear}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(t);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const d = String(parsed.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

function normalizeHeader(s: string | undefined | null): string {
  if (s === undefined || s === null) return "";
  return String(s).toLowerCase().replace(/[-_\s]+/g, " ").trim();
}

function extractMonthLabel(s: string | undefined | null): string | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  for (let i = 0; i < MONTH_KEYS.length; i++) {
    const re = new RegExp(`(?:^|[^a-z])${MONTH_KEYS[i]}(?:[^a-z]|$)`);
    if (re.test(lower)) {
      const yearMatch = lower.match(/20\d{2}/);
      const year = yearMatch ? yearMatch[0] : DEFAULT_YEAR;
      return `${MONTH_LABELS[i]} ${year}`;
    }
  }
  return null;
}

function deriveMemberCity(memberId: string): string | null {
  const upper = memberId.toUpperCase();
  const prefixes = Object.keys(MEMBER_CITY_PREFIX).sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of prefixes) {
    if (upper.startsWith(prefix)) return MEMBER_CITY_PREFIX[prefix];
  }
  return null;
}

// City label for revenue we can't attribute to a specific market. The
// common cause is a Stripe membership payment whose customer email no
// longer matches anything in fin_members — the player deleted their
// account between paying and our next members sync, so the email→city
// lookup misses. Surfaced as its own row at the bottom of Cash Flow's
// Revenue by City list.
const DELETED_ACCOUNT_CITY = "Deleted Account Revenue";

function memberCityFromId(memberId: string): string {
  return deriveMemberCity(memberId) ?? DELETED_ACCOUNT_CITY;
}

function normalizeSource(s: string | null): string | null {
  if (!s) return null;
  const u = s.toUpperCase();
  if (u === "STRIPE") return "Stripe";
  if (u === "VENMO") return "Venmo";
  if (u === "PROJECTION") return "PROJECTION";
  if (u === "MANUAL") return "Manual";
  return s;
}

function normalizeType(s: string | null): string | null {
  if (!s) return null;
  const l = s.toLowerCase();
  if (l === "dpp") return "DPP";
  if (l === "membership" || l === "member") return "Membership";
  if (l === "private rental" || l === "private" || l === "rental") {
    return "Private Rental";
  }
  return s;
}

function normalizeBillingType(s: string | null): string | null {
  if (!s) return null;
  const lc = s.toLowerCase().replace(/[\s-]+/g, "_");
  if (["per_hour", "per_match", "monthly_flat"].includes(lc)) return lc;
  return null;
}

// ===== Header detection =====

type ColumnSpec = {
  canonical: string;
  aliases?: string[];
  required: boolean;
};

type FixedDetection = {
  headerRowIndex: number;
  headerRow: string[];
  canonicalIndexMap: Record<string, number>;
};

function detectFixedHeader(
  raw: string[][],
  spec: ColumnSpec[],
  minMatches: number = 2,
  maxScan: number = 10,
): FixedDetection | null {
  const limit = Math.min(raw.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const row = raw[i] ?? [];
    const map: Record<string, number> = {};

    for (let j = 0; j < row.length; j++) {
      const cell = normalizeHeader(row[j]);
      if (!cell) continue;
      for (const c of spec) {
        if (c.canonical in map) continue;
        const aliases = [c.canonical, ...(c.aliases ?? [])].map(
          normalizeHeader,
        );
        if (aliases.includes(cell)) {
          map[c.canonical] = j;
          break;
        }
      }
    }

    if (Object.keys(map).length >= minMatches) {
      return { headerRowIndex: i, headerRow: row, canonicalIndexMap: map };
    }
  }
  return null;
}

type FixedRows = { rows: Record<string, string>[]; headerRow: string[] };

function preprocessFixed(
  raw: string[][],
  spec: ColumnSpec[],
): FixedRows | { error: string } {
  const detection = detectFixedHeader(raw, spec);
  if (!detection) {
    const expected = spec.map((c) => c.canonical).join(", ");
    return {
      error: `No header row found in first 10 rows. Expected at least 2 of: ${expected}.`,
    };
  }

  const { headerRowIndex, headerRow, canonicalIndexMap } = detection;
  const found = Object.keys(canonicalIndexMap);
  const missingRequired = spec
    .filter((c) => c.required && !found.includes(c.canonical))
    .map((c) => c.canonical);

  if (missingRequired.length > 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    return {
      error: `Detected header row ${headerRowIndex + 1}: "${detected}". Missing required columns: ${missingRequired.join(", ")}.`,
    };
  }

  const rows: Record<string, string>[] = [];
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const row = raw[i] ?? [];
    const obj: Record<string, string> = {};
    let hasAny = false;
    for (const [canon, idx] of Object.entries(canonicalIndexMap)) {
      const value = row[idx] ?? "";
      obj[canon] = value;
      if (value && String(value).trim() !== "") hasAny = true;
    }
    if (hasAny) rows.push(obj);
  }

  return { rows, headerRow };
}

type WideDetection = {
  headerRowIndex: number;
  headerRow: string[];
  fixedIndex: Record<string, number>;
};

function detectWideHeader(
  raw: string[][],
  fixedRequired: ColumnSpec[],
  wideTest: (header: string) => boolean,
  minWide: number = 1,
  maxScan: number = 10,
): WideDetection | { error: string } {
  const limit = Math.min(raw.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const row = raw[i] ?? [];
    const fixedIndex: Record<string, number> = {};
    let wideCount = 0;

    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const norm = normalizeHeader(cell);

      for (const c of fixedRequired) {
        if (c.canonical in fixedIndex) continue;
        const aliases = [c.canonical, ...(c.aliases ?? [])].map(
          normalizeHeader,
        );
        if (norm && aliases.includes(norm)) {
          fixedIndex[c.canonical] = j;
          break;
        }
      }

      if (cell && wideTest(String(cell))) wideCount++;
    }

    const allFixedFound = fixedRequired.every(
      (c) => c.canonical in fixedIndex,
    );
    if (allFixedFound && wideCount >= minWide) {
      return { headerRowIndex: i, headerRow: row, fixedIndex };
    }
  }

  const fixedNames = fixedRequired.map((c) => c.canonical).join(" + ");
  return {
    error: `No header row found in first 10 rows. Expected: ${fixedNames}, plus at least ${minWide} matching column${minWide > 1 ? "s" : ""}.`,
  };
}

// ===== Delete helpers =====

async function deleteAll(table: string): Promise<void> {
  const { error } = await supabase.from(table).delete().gt("id", 0);
  if (error) throw new Error(error.message);
}

async function clearMonths(table: string, months: string[]): Promise<void> {
  const unique = [...new Set(months.filter(Boolean))];
  if (unique.length === 0) return;
  const { error } = await supabase.from(table).delete().in("month", unique);
  if (error) throw new Error(error.message);
}

// ===== Specs and importers =====

const VENUES_SPEC: ColumnSpec[] = [
  { canonical: "Venue Name", aliases: ["Venue"], required: true },
  { canonical: "City", required: true },
  { canonical: "Billing Type", required: true },
  { canonical: "Hourly Rate", required: false },
  { canonical: "Monthly Flat", required: false },
  { canonical: "Per Match Rate", aliases: ["Per-Match Rate"], required: false },
  { canonical: "Max Spots", aliases: ["Spots"], required: false },
  { canonical: "Notes", required: false },
  { canonical: "Launch Date", required: false },
  { canonical: "Is Active", aliases: ["Active"], required: false },
];

export async function importVenues(raw: string[][]): Promise<ImportResult> {
  const result = preprocessFixed(raw, VENUES_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows, headerRow } = result;

  const mapped = rows
    .map((r) => ({
      venue_name: trim(r["Venue Name"]),
      city: trim(r["City"]),
      billing_type: normalizeBillingType(trim(r["Billing Type"])),
      hourly_rate: parseNum(r["Hourly Rate"]),
      monthly_flat: parseNum(r["Monthly Flat"]),
      per_match_rate: parseNum(r["Per Match Rate"]),
      max_spots: parseInteger(r["Max Spots"]),
      notes: trim(r["Notes"]),
      launch_date: parseDate(r["Launch Date"]),
      is_active: parseBool(r["Is Active"], true),
    }))
    .filter((r) => r.venue_name && r.city);

  const missingBilling = mapped.filter((r) => !r.billing_type);
  if (missingBilling.length > 0) {
    throw new Error(
      `${missingBilling.length} row(s) have an invalid Billing Type. Must be per_hour, per_match, or monthly_flat (e.g. "${trim(rows[0]?.["Billing Type"]) ?? "—"}" not recognized).`,
    );
  }

  const valid = mapped.filter(
    (r): r is typeof r & { billing_type: string } => r.billing_type !== null,
  );

  if (valid.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data rows had Venue Name + City + Billing Type filled in.`,
    );
  }

  const { error } = await supabase
    .from("fin_venues")
    .upsert(valid, { onConflict: "venue_name" });
  if (error) throw new Error(error.message);
  return { count: valid.length };
}

const PRICING_SPEC: ColumnSpec[] = [
  { canonical: "Venue Name", aliases: ["Venue"], required: true },
  { canonical: "City", required: true },
  { canonical: "DPP Price", aliases: ["DPP"], required: true },
  { canonical: "Member Price", aliases: ["Member"], required: true },
  { canonical: "Notes", required: false },
];

export async function importPricing(raw: string[][]): Promise<ImportResult> {
  const result = preprocessFixed(raw, PRICING_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows, headerRow } = result;

  const mapped = rows
    .map((r) => ({
      venue_name: trim(r["Venue Name"]),
      city: trim(r["City"]),
      dpp_price: parseNum(r["DPP Price"]),
      member_price: parseNum(r["Member Price"]),
      notes: trim(r["Notes"]),
    }))
    .filter(
      (r) =>
        r.venue_name &&
        r.city &&
        r.dpp_price !== null &&
        r.member_price !== null,
    );

  if (mapped.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data rows had Venue Name + City + DPP Price + Member Price filled in.`,
    );
  }
  const { error } = await supabase
    .from("fin_pricing")
    .upsert(mapped, { onConflict: "venue_name" });
  if (error) throw new Error(error.message);
  return { count: mapped.length };
}

const REVENUE_SPEC: ColumnSpec[] = [
  { canonical: "Date", required: true },
  { canonical: "Month", required: true },
  { canonical: "City", required: true },
  { canonical: "Venue", required: false },
  { canonical: "Type", required: true },
  { canonical: "Gross", aliases: ["Gross Amount"], required: true },
  { canonical: "Fees", required: false },
  { canonical: "Source", required: true },
  { canonical: "Notes", required: false },
];

export async function importRevenue(raw: string[][]): Promise<ImportResult> {
  const result = preprocessFixed(raw, REVENUE_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows, headerRow } = result;

  const mapped = rows
    .map((r) => ({
      date: parseDate(r["Date"]),
      month: trim(r["Month"]),
      city: trim(r["City"]),
      venue: trim(r["Venue"]),
      type: normalizeType(trim(r["Type"])),
      gross: parseNum(r["Gross"]),
      fees: parseNum(r["Fees"]) ?? 0,
      source: normalizeSource(trim(r["Source"])),
      notes: trim(r["Notes"]),
    }))
    .filter(
      (r) =>
        r.date &&
        r.month &&
        r.city &&
        r.type &&
        r.source &&
        r.gross !== null,
    );

  if (mapped.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data rows had Date + Month + City + Type + Source + Gross filled in.`,
    );
  }

  await clearMonths(
    "fin_revenue",
    mapped.map((r) => r.month!),
  );

  const BATCH = 500;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const { error } = await supabase.from("fin_revenue").insert(chunk);
    if (error) throw new Error(error.message);
  }
  return {
    count: mapped.length,
    note: `Replaced ${[...new Set(mapped.map((r) => r.month!))].length} month(s).`,
  };
}

const EXPENSES_SPEC: ColumnSpec[] = [
  { canonical: "Date", required: true },
  { canonical: "Month", required: true },
  { canonical: "City", required: true },
  { canonical: "Category", required: true },
  { canonical: "Vendor", required: false },
  { canonical: "Amount", required: true },
  { canonical: "Notes", required: false },
];

export async function importExpenses(raw: string[][]): Promise<ImportResult> {
  const result = preprocessFixed(raw, EXPENSES_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows, headerRow } = result;

  const mapped = rows
    .map((r) => ({
      date: parseDate(r["Date"]),
      month: trim(r["Month"]),
      city: trim(r["City"]),
      category: trim(r["Category"]),
      vendor: trim(r["Vendor"]),
      amount: parseNum(r["Amount"]),
      notes: trim(r["Notes"]),
    }))
    .filter(
      (r) => r.date && r.month && r.city && r.category && r.amount !== null,
    );

  if (mapped.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data rows had Date + Month + City + Category + Amount filled in.`,
    );
  }

  await clearMonths(
    "fin_expenses",
    mapped.map((r) => r.month!),
  );

  const BATCH = 500;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const { error } = await supabase.from("fin_expenses").insert(chunk);
    if (error) throw new Error(error.message);
  }
  return {
    count: mapped.length,
    note: `Replaced ${[...new Set(mapped.map((r) => r.month!))].length} month(s).`,
  };
}

const SCHEDULE_SPEC: ColumnSpec[] = [
  { canonical: "Date", required: true },
  { canonical: "Month", required: true },
  { canonical: "City", required: true },
  { canonical: "Venue", required: true },
  { canonical: "Match Count", aliases: ["Matches"], required: false },
  { canonical: "Total Hours", aliases: ["Hours"], required: false },
  { canonical: "Venue Cost", aliases: ["Cost"], required: false },
  { canonical: "Notes", required: false },
];

type SchedulePreviewRow = {
  date: string;
  month: string;
  city: string;
  venue: string;
  match_count: number;
  total_hours: number | null;
  venue_cost: number | null;
  notes: string | null;
};

type ScheduleManualConflict = {
  id: number;
  date: string;
  month: string;
  city: string;
  venue: string;
  match_count: number;
  notes: string | null;
  created_by: string | null;
};

export type SchedulePreview = {
  filename: string;
  rows: SchedulePreviewRow[];
  monthsCovered: string[];
  manualConflicts: ScheduleManualConflict[];
};

export async function parseSchedulePreview(
  raw: string[][],
  filename: string,
): Promise<SchedulePreview> {
  const result = preprocessFixed(raw, SCHEDULE_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows, headerRow } = result;

  const mapped: SchedulePreviewRow[] = rows
    .map((r) => ({
      date: parseDate(r["Date"]) ?? "",
      month: trim(r["Month"]) ?? "",
      city: trim(r["City"]) ?? "",
      venue: trim(r["Venue"]) ?? "",
      match_count: parseInteger(r["Match Count"]) ?? 1,
      total_hours: parseNum(r["Total Hours"]),
      venue_cost: parseNum(r["Venue Cost"]),
      notes: trim(r["Notes"]),
    }))
    .filter((r) => r.date && r.month && r.city && r.venue);

  if (mapped.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data rows had Date + Month + City + Venue filled in.`,
    );
  }

  const monthsCovered = [...new Set(mapped.map((r) => r.month))].sort();

  const { data: conflicts, error } = await supabase
    .from("fin_schedule")
    .select("id, date, month, city, venue, match_count, notes, created_by")
    .in("month", monthsCovered)
    .eq("manual_entry", true)
    .order("date", { ascending: true });
  if (error) throw new Error(`Manual-row lookup failed: ${error.message}`);

  return {
    filename,
    rows: mapped,
    monthsCovered,
    manualConflicts: (conflicts ?? []) as ScheduleManualConflict[],
  };
}

export async function commitScheduleImport(
  preview: SchedulePreview,
  mode: "preserve" | "replace",
): Promise<ImportResult> {
  if (preview.rows.length === 0) {
    return { count: 0, note: "No rows to insert." };
  }

  if (mode === "replace") {
    // Original behavior: drop all rows for the months covered, then insert.
    await clearMonths("fin_schedule", preview.monthsCovered);
  } else {
    // Preserve manual entries: drop only Sheet-imported rows for those months.
    const { error } = await supabase
      .from("fin_schedule")
      .delete()
      .in("month", preview.monthsCovered)
      .eq("manual_entry", false);
    if (error) throw new Error(error.message);
  }

  const BATCH = 500;
  for (let i = 0; i < preview.rows.length; i += BATCH) {
    const chunk = preview.rows.slice(i, i + BATCH).map((r) => ({
      ...r,
      manual_entry: false,
    }));
    const { error } = await supabase.from("fin_schedule").insert(chunk);
    if (error) throw new Error(error.message);
  }

  const note =
    mode === "replace"
      ? `Replaced everything (${preview.manualConflicts.length} manual rows deleted).`
      : preview.manualConflicts.length > 0
        ? `Preserved ${preview.manualConflicts.length} manual ${preview.manualConflicts.length === 1 ? "entry" : "entries"}.`
        : undefined;

  return { count: preview.rows.length, note };
}

export async function importSchedule(raw: string[][]): Promise<ImportResult> {
  const result = preprocessFixed(raw, SCHEDULE_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows, headerRow } = result;

  const mapped = rows
    .map((r) => ({
      date: parseDate(r["Date"]),
      month: trim(r["Month"]),
      city: trim(r["City"]),
      venue: trim(r["Venue"]),
      match_count: parseInteger(r["Match Count"]) ?? 1,
      total_hours: parseNum(r["Total Hours"]),
      venue_cost: parseNum(r["Venue Cost"]),
      notes: trim(r["Notes"]),
    }))
    .filter((r) => r.date && r.month && r.city && r.venue);

  if (mapped.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data rows had Date + Month + City + Venue filled in.`,
    );
  }

  // Legacy one-shot path — preserves manual entries by default. The new
  // /admin/finance/import Schedule card uses parseSchedulePreview +
  // commitScheduleImport for the keep/replace dialog.
  const monthsCovered = [...new Set(mapped.map((r) => r.month).filter(Boolean))] as string[];
  const { error: delErr } = await supabase
    .from("fin_schedule")
    .delete()
    .in("month", monthsCovered)
    .eq("manual_entry", false);
  if (delErr) throw new Error(delErr.message);

  const BATCH = 500;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH).map((r) => ({
      ...r,
      manual_entry: false,
    }));
    const { error } = await supabase.from("fin_schedule").insert(chunk);
    if (error) throw new Error(error.message);
  }
  return {
    count: mapped.length,
    note: `Replaced ${[...new Set(mapped.map((r) => r.month!))].length} month(s).`,
  };
}

const APR_TOTAL_RE = /^(apr|april)\s+total$/;
const MAY_TOTAL_RE = /^may\s+total$/;
const JUN_TOTAL_RE = /^(jun|june)\s+total$/;

function detectManagerPayHeader(raw: string[][]):
  | {
      headerRowIndex: number;
      headerRow: string[];
      cityIdx: number;
      aprIdx: number;
      mayIdx: number;
      junIdx: number;
    }
  | { error: string } {
  const limit = Math.min(raw.length, 15);
  for (let i = 0; i < limit; i++) {
    const row = raw[i] ?? [];
    let cityIdx = -1;
    let aprIdx = -1;
    let mayIdx = -1;
    let junIdx = -1;
    for (let j = 0; j < row.length; j++) {
      const norm = normalizeHeader(row[j]);
      if (cityIdx === -1 && norm === "city") cityIdx = j;
      if (aprIdx === -1 && APR_TOTAL_RE.test(norm)) aprIdx = j;
      if (mayIdx === -1 && MAY_TOTAL_RE.test(norm)) mayIdx = j;
      if (junIdx === -1 && JUN_TOTAL_RE.test(norm)) junIdx = j;
    }
    if (cityIdx >= 0 && aprIdx >= 0 && mayIdx >= 0 && junIdx >= 0) {
      return { headerRowIndex: i, headerRow: row, cityIdx, aprIdx, mayIdx, junIdx };
    }
  }
  return {
    error:
      "Couldn't find a header row with 'City' + 'Apr Total' + 'May Total' + 'Jun Total' in the first 15 rows.",
  };
}

export async function importManagerPay(
  raw: string[][],
): Promise<ImportResult> {
  const detection = detectManagerPayHeader(raw);
  if ("error" in detection) throw new Error(detection.error);
  const { headerRowIndex, cityIdx, aprIdx, mayIdx, junIdx } = detection;

  const monthCols: { idx: number; month: string }[] = [
    { idx: aprIdx, month: "Apr 2026" },
    { idx: mayIdx, month: "May 2026" },
    { idx: junIdx, month: "Jun 2026" },
  ];

  const byKey = new Map<
    string,
    { city: string; month: string; amount: number }
  >();

  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const row = raw[i] ?? [];
    const cellRaw = String(row[cityIdx] ?? "");
    if (/^\s/.test(cellRaw)) continue;
    const city = cellRaw.trim();
    if (!city) continue;
    if (/^grand\s*total/i.test(city)) continue;

    for (const mc of monthCols) {
      const amount = parseNum(row[mc.idx]) ?? 0;
      if (amount === 0) continue;
      const key = `${city}|${mc.month}`;
      const existing = byKey.get(key);
      if (existing) existing.amount += amount;
      else byKey.set(key, { city, month: mc.month, amount });
    }
  }

  const longRows = [...byKey.values()];
  if (longRows.length === 0) {
    throw new Error(
      `Detected header at row ${headerRowIndex + 1}, but no (city, month) rows produced any amount.`,
    );
  }

  const { error } = await supabase
    .from("fin_manager_pay")
    .upsert(longRows, { onConflict: "city,month" });
  if (error) throw new Error(error.message);
  return { count: longRows.length };
}

type ExpenseCategory = "city_manager" | "marketing" | "equipment";

const FULL_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function matchSimpleMonth(s: string): string | null {
  const norm = normalizeHeader(s);
  for (let i = 0; i < MONTH_KEYS.length; i++) {
    if (norm === MONTH_KEYS[i] || norm === FULL_MONTHS[i]) {
      return `${MONTH_LABELS[i]} ${DEFAULT_YEAR}`;
    }
  }
  return null;
}

function detectMonthlyExpensesHeaders(raw: string[][]):
  | {
      monthRowIndex: number;
      categoryRow: string[];
      monthRow: string[];
      cityIdx: number;
    }
  | { error: string } {
  const limit = Math.min(raw.length, 15);
  for (let i = 1; i < limit; i++) {
    const row = raw[i] ?? [];
    let cityIdx = -1;
    let monthHits = 0;
    for (let j = 0; j < row.length; j++) {
      const norm = normalizeHeader(row[j]);
      if (cityIdx === -1 && norm === "city") cityIdx = j;
      if (matchSimpleMonth(row[j] ?? "")) monthHits++;
    }
    if (cityIdx >= 0 && monthHits >= 6) {
      return {
        monthRowIndex: i,
        categoryRow: raw[i - 1] ?? [],
        monthRow: row,
        cityIdx,
      };
    }
  }
  return {
    error:
      "Couldn't find a month sub-header row (with 'City' and Apr/May/Jun) in the first 15 rows.",
  };
}

export async function importMonthlyExpenses(
  raw: string[][],
): Promise<ImportResult> {
  const detection = detectMonthlyExpensesHeaders(raw);
  if ("error" in detection) throw new Error(detection.error);
  const { monthRowIndex, categoryRow, monthRow, cityIdx } = detection;

  const colMap: { idx: number; category: ExpenseCategory; month: string }[] =
    [];
  let currentCategory: ExpenseCategory | "skip" | null = null;

  for (let j = 0; j < monthRow.length; j++) {
    if (j === cityIdx) {
      currentCategory = null;
      continue;
    }

    const catCell = String(categoryRow[j] ?? "").trim();
    if (catCell) {
      const lower = catCell.toLowerCase();
      if (lower.includes("city manager")) currentCategory = "city_manager";
      else if (lower.includes("marketing")) currentCategory = "marketing";
      else if (lower.includes("equipment")) currentCategory = "equipment";
      else currentCategory = "skip";
    }

    if (!currentCategory || currentCategory === "skip") continue;

    const month = matchSimpleMonth(monthRow[j] ?? "");
    if (!month) continue;

    colMap.push({ idx: j, category: currentCategory, month });
  }

  if (colMap.length === 0) {
    throw new Error(
      "No (category, month) columns mapped. Expected categories like 'City Manager', 'Marketing / Paid Social', 'Equipment' above Apr/May/Jun.",
    );
  }

  const byKey = new Map<
    string,
    {
      city: string;
      month: string;
      city_manager: number;
      marketing: number;
      equipment: number;
    }
  >();

  for (let i = monthRowIndex + 1; i < raw.length; i++) {
    const row = raw[i] ?? [];
    const cellRaw = String(row[cityIdx] ?? "");
    if (/^\s/.test(cellRaw)) continue;
    const city = cellRaw.trim();
    if (!city) continue;
    if (/^grand\s*total/i.test(city)) continue;

    for (const cm of colMap) {
      const value = parseNum(row[cm.idx]) ?? 0;
      const key = `${city}|${cm.month}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          city,
          month: cm.month,
          city_manager: 0,
          marketing: 0,
          equipment: 0,
        };
        byKey.set(key, entry);
      }
      entry[cm.category] = value;
    }
  }

  const longRows = [...byKey.values()];
  if (longRows.length === 0) {
    throw new Error(
      `Detected month row ${monthRowIndex + 1} with categories above. No data rows produced.`,
    );
  }
  const { error } = await supabase
    .from("fin_monthly_expenses")
    .upsert(longRows, { onConflict: "city,month" });
  if (error) throw new Error(error.message);
  return { count: longRows.length };
}

const MEMBERS_SPEC: ColumnSpec[] = [
  {
    canonical: "member_id",
    aliases: ["Member ID", "Customer ID", "ID"],
    required: true,
  },
  {
    canonical: "email",
    aliases: ["Member Email", "Customer Email", "Email Address"],
    required: false,
  },
  {
    canonical: "status",
    aliases: ["Subscription Status", "Membership Status"],
    required: true,
  },
  { canonical: "first_name", aliases: ["First Name", "FirstName"], required: false },
  { canonical: "last_name", aliases: ["Last Name", "LastName"], required: false },
  {
    canonical: "phone",
    aliases: ["Phone Number", "Phone", "Mobile"],
    required: false,
  },
  {
    canonical: "activation_date",
    aliases: ["Member Activation Date", "Activation Date", "Activated At"],
    required: false,
  },
  {
    canonical: "membership_length",
    aliases: ["Membership Length", "Plan Length"],
    required: false,
  },
  {
    canonical: "price_cents",
    aliases: ["Price Cents", "Price"],
    required: true,
  },
  {
    canonical: "canceled_at",
    aliases: ["Canceled At", "Cancellation Date"],
    required: false,
  },
  {
    canonical: "cancel_reason",
    aliases: ["Cancel Reason", "Cancellation Reason"],
    required: false,
  },
];

type MemberRow = {
  member_id: string;
  email: string | null;
  status: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  activation_date: string | null;
  membership_length: string | null;
  price_cents: number;
  canceled_at: string | null;
  cancel_reason: string | null;
  city: string;
};

export type MembersPreview = {
  filename: string;
  totalMembers: number;
  byStatus: Record<string, number>;
  activeByCity: Record<string, number>;
  parsed: MemberRow[];
};

function parseStripeTimestamp(v: string | undefined | null): string | null {
  const t = trim(v);
  if (!t) return null;
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

function parseMembersRows(raw: string[][]): MemberRow[] {
  const result = preprocessFixed(raw, MEMBERS_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows } = result;

  const out: MemberRow[] = [];
  for (const r of rows) {
    const memberId = trim(r["member_id"]);
    if (!memberId) continue;
    const status = (trim(r["status"]) ?? "").toUpperCase();
    const emailRaw = trim(r["email"]);
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    const priceCents = parseInteger(r["price_cents"]) ?? 0;
    out.push({
      member_id: memberId,
      email,
      status,
      first_name: trim(r["first_name"]),
      last_name: trim(r["last_name"]),
      phone: trim(r["phone"]),
      activation_date: parseDate(r["activation_date"]),
      membership_length: trim(r["membership_length"]),
      price_cents: priceCents,
      canceled_at: parseStripeTimestamp(r["canceled_at"]),
      cancel_reason: trim(r["cancel_reason"]),
      city: memberCityFromId(memberId),
    });
  }
  return out;
}

export function previewMembers(raw: string[][], filename: string): MembersPreview {
  const parsed = parseMembersRows(raw);
  const byStatus: Record<string, number> = {};
  const activeByCity: Record<string, number> = {};
  for (const m of parsed) {
    byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    if (m.status === "ACTIVE" && m.price_cents > 0) {
      activeByCity[m.city] = (activeByCity[m.city] ?? 0) + 1;
    }
  }
  return {
    filename,
    totalMembers: parsed.length,
    byStatus,
    activeByCity,
    parsed,
  };
}

export async function commitMembers(
  parsed: MemberRow[],
): Promise<ImportResult> {
  await deleteAll("fin_members");
  if (parsed.length === 0) {
    return { count: 0, note: "No rows to insert." };
  }
  const BATCH = 500;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk = parsed.slice(i, i + BATCH);
    const { error } = await supabase.from("fin_members").insert(chunk);
    if (error) throw new Error(error.message);
  }
  return { count: parsed.length };
}

export async function importMembers(raw: string[][]): Promise<ImportResult> {
  const parsed = parseMembersRows(raw);
  const r = await commitMembers(parsed);
  const byStatus: Record<string, number> = {};
  for (const m of parsed) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  const note = Object.entries(byStatus)
    .map(([s, n]) => `${s}: ${n}`)
    .join(" · ");
  return { count: r.count, note };
}

type SpotsType = "member" | "dpp" | "other";

function parseMemberSpotsHeader(
  header: string,
): { month: string; type: SpotsType } | null {
  const lower = header.toLowerCase();
  let type: SpotsType | null = null;
  if (lower.includes("member")) type = "member";
  else if (lower.includes("dpp")) type = "dpp";
  else if (lower.includes("other")) type = "other";
  if (!type) return null;
  const month = extractMonthLabel(lower);
  if (!month) return null;
  return { month, type };
}

export async function importMemberSpots(
  raw: string[][],
): Promise<ImportResult> {
  const detection = detectWideHeader(
    raw,
    [
      { canonical: "Venue", required: true },
      { canonical: "City", required: true },
    ],
    (h) => parseMemberSpotsHeader(h) !== null,
    1,
  );
  if ("error" in detection) throw new Error(detection.error);
  const { headerRowIndex, headerRow, fixedIndex } = detection;

  const venueIdx = fixedIndex["Venue"];
  const cityIdx = fixedIndex["City"];
  const parsedHeaders: {
    index: number;
    parsed: { month: string; type: SpotsType };
  }[] = [];
  for (let i = 0; i < headerRow.length; i++) {
    if (i === venueIdx || i === cityIdx) continue;
    const p = parseMemberSpotsHeader(headerRow[i] ?? "");
    if (p) parsedHeaders.push({ index: i, parsed: p });
  }

  const byKey = new Map<
    string,
    {
      venue: string;
      city: string;
      month: string;
      member_spots: number;
      dpp_spots: number;
      other_spots: number;
    }
  >();
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const row = raw[i] ?? [];
    const venue = trim(row[venueIdx]);
    const city = trim(row[cityIdx]);
    if (!venue || !city) continue;
    for (const ph of parsedHeaders) {
      const num = parseInteger(row[ph.index]);
      if (num === null) continue;
      const key = `${venue}|${ph.parsed.month}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          venue,
          city,
          month: ph.parsed.month,
          member_spots: 0,
          dpp_spots: 0,
          other_spots: 0,
        };
        byKey.set(key, entry);
      }
      if (ph.parsed.type === "member") entry.member_spots = num;
      else if (ph.parsed.type === "dpp") entry.dpp_spots = num;
      else entry.other_spots = num;
    }
  }

  const longRows = [...byKey.values()];
  if (longRows.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data rows produced.`,
    );
  }
  const { error } = await supabase
    .from("fin_member_spots")
    .upsert(longRows, { onConflict: "venue,month" });
  if (error) throw new Error(error.message);
  return { count: longRows.length };
}

export async function importCommentary(
  raw: string[][],
): Promise<ImportResult> {
  let eyebrow: string | null = null;
  let body: string | null = null;

  for (const row of raw) {
    if (!row || row.length === 0) continue;
    const key = normalizeHeader(row[0]);
    const value = trim(row[1]);
    if (!value) continue;
    if (key === "eyebrow") eyebrow = value;
    else if (key === "body") body = value;
  }

  if (!eyebrow && !body) {
    throw new Error(
      "CSV must contain rows with 'Eyebrow' and 'Body' in column A and the values in column B.",
    );
  }
  if (!eyebrow) throw new Error("Missing 'Eyebrow' row.");
  if (!body) throw new Error("Missing 'Body' row.");

  const { data: existingRow } = await supabase
    .from("fin_commentary")
    .select("id")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  const existing = existingRow as { id: number } | null;

  if (existing) {
    const { error } = await supabase
      .from("fin_commentary")
      .update({
        eyebrow,
        body,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { count: 1, note: "Updated existing entry." };
  }

  const { error } = await supabase.from("fin_commentary").insert({
    eyebrow,
    body,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return { count: 1, note: "Created new entry." };
}

// ===== Stripe weekly upload =====

const STRIPE_CITY_PREFIX: Record<string, string> = {
  ATX: "Austin",
  DFW: "Dallas",
  HOU: "Houston",
  SATX: "San Antonio",
  ATL: "Atlanta",
  STL: "St. Louis",
  OKC: "OKC",
  ELP: "El Paso",
};

const STRIPE_SPEC: ColumnSpec[] = [
  {
    canonical: "stripe_id",
    aliases: ["id", "Charge ID", "Payment ID"],
    required: false,
  },
  {
    canonical: "created",
    aliases: [
      "Created date (UTC)",
      "Created Date (UTC)",
      "Created Date",
      "Created (UTC)",
      "Created",
      "Date",
    ],
    required: true,
  },
  {
    canonical: "amount",
    aliases: ["Amount", "Converted Amount", "Gross"],
    required: true,
  },
  {
    canonical: "fees",
    aliases: ["Fee", "Stripe Fee", "Fees", "Application Fee"],
    required: false,
  },
  {
    canonical: "status",
    aliases: ["Status", "Payment Status"],
    required: true,
  },
  {
    canonical: "description",
    aliases: ["Description", "Statement Descriptor"],
    required: false,
  },
  {
    canonical: "customer_email",
    aliases: ["Customer Email", "Email", "metadata[email]"],
    required: false,
  },
  {
    canonical: "city_identifier",
    aliases: [
      "cityIdentifier (metadata)",
      "cityIdentifier",
      "City Identifier",
      "metadata[cityIdentifier]",
      "City Code",
    ],
    required: false,
  },
  {
    canonical: "stripe_type",
    aliases: ["type (metadata)", "metadata[type]", "Type (metadata)"],
    required: false,
  },
  {
    canonical: "venue",
    aliases: [
      "Venue",
      "venue (metadata)",
      "metadata[venue]",
      "venueName (metadata)",
      "metadata[venueName]",
    ],
    required: false,
  },
  {
    canonical: "match_name",
    aliases: [
      "matchName (metadata)",
      "metadata[matchName]",
      "Match Name",
    ],
    required: false,
  },
  {
    canonical: "match_id",
    aliases: ["matchId (metadata)", "metadata[matchId]", "Match ID"],
    required: false,
  },
];

const PAID_STATUSES = new Set(["paid", "succeeded"]);

type StripeAllocatedRow = {
  date: string;
  month: string;
  city: string;
  venue: string | null;
  type: "DPP" | "Membership" | "Strike";
  gross: number;
  fees: number;
  source: "Stripe";
  notes: string | null;
};

export type StripeVenueResolution = {
  original: string;
  canonical: string | null;
  count: number;
};

export type StripePreview = {
  filename: string;
  totalRows: number;
  paidRows: number;
  skippedRows: number;
  membershipPayments: number;
  emailAllocated: number;
  unmatchedEmails: string[];
  matchPayments: number;
  matchUnmatchedCityCodes: string[];
  matchVenueResolutions: StripeVenueResolution[];
  matchRowsWithVenue: number;
  matchRowsWithoutVenue: number;
  strikePayments: number;
  strikeSkipped: number;
  earliestDate: string | null;
  latestDate: string | null;
  monthsAffected: string[];
  totalGross: number;
  aggregatedRowCount: number;
  parsed: StripeAllocatedRow[];
};

function monthLabelFromIsoDate(iso: string): string | null {
  const m = iso.match(/^(\d{4})-(\d{2})-/);
  if (!m) return null;
  const monthIndex = parseInt(m[2], 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return `${MONTH_LABELS[monthIndex]} ${m[1]}`;
}

function looksLikeMembership(
  stripeType: string | null,
  description: string | null,
  cityIdentifier: string | null,
): boolean {
  // Prefer the explicit Stripe `type` metadata when present.
  if (stripeType) {
    const t = stripeType.toLowerCase();
    if (/subscription|membership/.test(t)) return true;
    if (/match|dpp/.test(t)) return false;
    // Unknown explicit type — fall through to the heuristic below.
  }
  if (!cityIdentifier) return true;
  if (description && /subscription|membership/i.test(description)) return true;
  return false;
}

function cityFromIdentifier(code: string | null): string {
  if (!code) return DELETED_ACCOUNT_CITY;
  const upper = code.toUpperCase().trim();
  const prefixes = Object.keys(STRIPE_CITY_PREFIX).sort(
    (a, b) => b.length - a.length,
  );
  for (const p of prefixes) {
    if (upper.startsWith(p)) return STRIPE_CITY_PREFIX[p];
  }
  return DELETED_ACCOUNT_CITY;
}

function aggregateStripeRows(
  perTxn: StripeAllocatedRow[],
): StripeAllocatedRow[] {
  type Bucket = {
    date: string;
    month: string;
    city: string;
    venue: string | null;
    type: "DPP" | "Membership" | "Strike";
    gross: number;
    fees: number;
    txnCount: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of perTxn) {
    // (date, city, type, venue) — venue stays in the key so per-venue Phase 3
    // rollups (DPP) keep working when Stripe metadata supplies a venue.
    const key = `${r.date}|${r.city}|${r.type}|${r.venue ?? ""}`;
    const cur = buckets.get(key);
    if (cur) {
      cur.gross += r.gross;
      cur.fees += r.fees;
      cur.txnCount += 1;
    } else {
      buckets.set(key, {
        date: r.date,
        month: r.month,
        city: r.city,
        venue: r.venue,
        type: r.type,
        gross: r.gross,
        fees: r.fees,
        txnCount: 1,
      });
    }
  }
  return [...buckets.values()].map((b) => ({
    date: b.date,
    month: b.month,
    city: b.city,
    venue: b.venue,
    type: b.type,
    gross: b.gross,
    fees: b.fees,
    source: "Stripe" as const,
    notes: `${b.txnCount} Stripe ${
      b.type === "Membership"
        ? "subscription"
        : b.type === "Strike"
          ? "strike"
          : "DPP"
    } txn${b.txnCount === 1 ? "" : "s"}`,
  }));
}

export async function previewStripe(
  raw: string[][],
  filename: string,
): Promise<StripePreview> {
  const result = preprocessFixed(raw, STRIPE_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows } = result;

  // Build email → city map from fin_members. Paginated — without it
  // PostgREST silently caps at 1000 rows even though fin_members holds
  // 2k+ customers, which leaves a chunk of email→city lookups stranded
  // in the Deleted Account Revenue bucket.
  let memberRows: Array<{ email: string | null; city: string | null }>;
  try {
    memberRows = await selectAll<{ email: string | null; city: string | null }>(
      () => supabase.from("fin_members").select("email, city").order("id"),
    );
  } catch (e) {
    throw new Error(
      `Members lookup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const emailToCity = new Map<string, string>();
  for (const m of memberRows) {
    if (m.email) emailToCity.set(m.email.toLowerCase().trim(), m.city ?? DELETED_ACCOUNT_CITY);
  }

  // Build alias map from fin_venue_aliases for venue normalization on
  // match-type rows.
  const { data: aliasRows, error: alErr } = await supabase
    .from("fin_venue_aliases")
    .select("alias, canonical_venue");
  if (alErr) throw new Error(`Alias lookup failed: ${alErr.message}`);
  const aliasMap = new Map<string, string>();
  for (const a of (aliasRows ?? []) as {
    alias: string | null;
    canonical_venue: string | null;
  }[]) {
    if (a.alias && a.canonical_venue) {
      aliasMap.set(a.alias.trim(), a.canonical_venue.trim());
    }
  }

  let totalRows = 0;
  let paidRows = 0;
  let skippedRows = 0;
  let membershipPayments = 0;
  let emailAllocated = 0;
  const unmatchedEmailSet = new Set<string>();
  let matchPayments = 0;
  const matchUnmatchedCityCodes = new Set<string>();
  const monthSet = new Set<string>();
  let earliestDate: string | null = null;
  let latestDate: string | null = null;
  let totalGross = 0;
  const parsed: StripeAllocatedRow[] = [];
  // Track raw matchName → canonical venue for the dry-run preview.
  type ResolutionAcc = { canonical: string | null; count: number };
  const venueResolutions = new Map<string, ResolutionAcc>();
  let matchRowsWithVenue = 0;
  let matchRowsWithoutVenue = 0;
  let strikePayments = 0;
  let strikeSkipped = 0;

  for (const r of rows) {
    totalRows++;
    const status = (trim(r["status"]) ?? "").toLowerCase();
    const stripeType = trim(r["stripe_type"]);
    const isStrikeType =
      stripeType !== null && stripeType.toLowerCase().includes("strike");
    if (!PAID_STATUSES.has(status)) {
      skippedRows++;
      if (isStrikeType) strikeSkipped++;
      continue;
    }
    const date = parseDate(r["created"]);
    if (!date) {
      skippedRows++;
      continue;
    }
    const gross = parseNum(r["amount"]) ?? 0;
    const fees = parseNum(r["fees"]) ?? 0;
    const description = trim(r["description"]);
    const emailRaw = trim(r["customer_email"]);
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    const cityIdentifier = trim(r["city_identifier"]);
    const explicitVenue = trim(r["venue"]);
    const matchName = trim(r["match_name"]);

    paidRows++;
    totalGross += gross;
    if (!earliestDate || date < earliestDate) earliestDate = date;
    if (!latestDate || date > latestDate) latestDate = date;
    const monthLabel = monthLabelFromIsoDate(date);
    if (monthLabel) monthSet.add(monthLabel);

    let allocatedCity: string;
    let type: "DPP" | "Membership" | "Strike";

    if (isStrikeType) {
      // Strikes are city-attributed but have no venue concept.
      type = "Strike";
      strikePayments++;
      allocatedCity = cityFromIdentifier(cityIdentifier);
      if (allocatedCity === DELETED_ACCOUNT_CITY && cityIdentifier) {
        matchUnmatchedCityCodes.add(cityIdentifier);
      }
    } else if (
      looksLikeMembership(stripeType, description, cityIdentifier)
    ) {
      type = "Membership";
      membershipPayments++;
      const lookup = email ? emailToCity.get(email) : undefined;
      if (lookup && lookup !== DELETED_ACCOUNT_CITY) {
        allocatedCity = lookup;
        emailAllocated++;
      } else {
        allocatedCity = DELETED_ACCOUNT_CITY;
        if (email) unmatchedEmailSet.add(email);
      }
    } else {
      type = "DPP";
      matchPayments++;
      allocatedCity = cityFromIdentifier(cityIdentifier);
      if (allocatedCity === DELETED_ACCOUNT_CITY && cityIdentifier) {
        matchUnmatchedCityCodes.add(cityIdentifier);
      }
    }

    // For DPP/match rows, resolve venue via the canonical normalizer:
    // (1) explicit Venue/metadata[venue] wins if present, (2) else apply
    // normalizeMatchName to the raw matchName (strips emoji, weekday
    // suffixes, etc.; consults DB aliases + cross-venue + prefix rules).
    let resolvedVenue: string | null = null;
    if (type === "DPP") {
      if (explicitVenue) {
        resolvedVenue = explicitVenue;
      } else if (matchName) {
        const res = normalizeMatchName(matchName, aliasMap);
        resolvedVenue = res.canonical;
        const key = res.original;
        const acc = venueResolutions.get(key);
        if (acc) {
          acc.count += 1;
        } else {
          venueResolutions.set(key, { canonical: res.canonical, count: 1 });
        }
      }
      if (resolvedVenue) matchRowsWithVenue += 1;
      else matchRowsWithoutVenue += 1;
    }

    parsed.push({
      date,
      month: monthLabel ?? "",
      city: allocatedCity,
      venue: resolvedVenue,
      type,
      gross,
      fees,
      source: "Stripe",
      notes: description,
    });
  }

  const aggregated = aggregateStripeRows(parsed);

  const matchVenueResolutions: StripeVenueResolution[] = [
    ...venueResolutions.entries(),
  ]
    .map(([original, acc]) => ({
      original,
      canonical: acc.canonical,
      count: acc.count,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    filename,
    totalRows,
    paidRows,
    skippedRows,
    membershipPayments,
    emailAllocated,
    unmatchedEmails: [...unmatchedEmailSet].sort(),
    matchPayments,
    matchUnmatchedCityCodes: [...matchUnmatchedCityCodes].sort(),
    matchVenueResolutions,
    matchRowsWithVenue,
    matchRowsWithoutVenue,
    strikePayments,
    strikeSkipped,
    earliestDate,
    latestDate,
    monthsAffected: [...monthSet].sort(),
    totalGross,
    aggregatedRowCount: aggregated.length,
    parsed: aggregated,
  };
}

export async function commitStripe(
  preview: StripePreview,
): Promise<ImportResult> {
  if (preview.parsed.length === 0 || !preview.earliestDate || !preview.latestDate) {
    return { count: 0, note: "No paid Stripe rows in the upload." };
  }

  // Date-range replace: drop existing Stripe rows in the covered window, then insert.
  const { error: delErr } = await supabase
    .from("fin_revenue")
    .delete()
    .eq("source", "Stripe")
    .gte("date", preview.earliestDate)
    .lte("date", preview.latestDate);
  if (delErr) throw new Error(`Delete failed: ${delErr.message}`);

  const BATCH = 500;
  for (let i = 0; i < preview.parsed.length; i += BATCH) {
    const chunk = preview.parsed.slice(i, i + BATCH);
    const { error } = await supabase.from("fin_revenue").insert(chunk);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
  return {
    count: preview.parsed.length,
    note: `${preview.earliestDate} → ${preview.latestDate}`,
  };
}

export type ImporterConfig = {
  key: string;
  title: string;
  description: string;
  expectedColumns: string;
  importer: (raw: string[][]) => Promise<ImportResult>;
};

export const FINANCE_IMPORTERS: ImporterConfig[] = [
  {
    key: "venues",
    title: "1. Venues",
    description:
      "Upserts by Venue Name. Header row is auto-detected in the first 10 rows.",
    expectedColumns:
      "Venue Name (or Venue), City, Billing Type (per_hour | per_match | monthly_flat), Hourly Rate, Monthly Flat, Per Match Rate (or Per-Match Rate), Max Spots, Notes, Launch Date, Is Active",
    importer: importVenues,
  },
  {
    key: "pricing",
    title: "2. Pricing",
    description:
      "Upserts by Venue Name. Header row is auto-detected in the first 10 rows.",
    expectedColumns:
      "Venue Name (or Venue), City, DPP Price, Member Price, Notes",
    importer: importPricing,
  },
  {
    key: "revenue",
    title: "3. Revenue",
    description:
      "Replaces all rows for the months covered by the CSV, then inserts new rows.",
    expectedColumns:
      "Date, Month, City, Venue, Type (DPP | Membership | Private Rental), Gross, Fees, Source (Stripe | Venmo | PROJECTION | Manual), Notes",
    importer: importRevenue,
  },
  {
    key: "expenses",
    title: "4. Expenses",
    description:
      "Replaces all rows for the months covered by the CSV, then inserts new rows.",
    expectedColumns: "Date, Month, City, Category, Vendor, Amount, Notes",
    importer: importExpenses,
  },
  {
    key: "schedule",
    title: "5. Schedule",
    description:
      "Replaces all rows for the months covered by the CSV, then inserts new rows.",
    expectedColumns:
      "Date, Month, City, Venue, Match Count, Total Hours, Venue Cost, Notes",
    importer: importSchedule,
  },
  // Manager Pay CSV path is retired — Match Manager Pay now flows through
  // /admin/finance/manager-pay (writes to fin_expenses, category='Match
  // Manager Pay'). Importer + fin_manager_pay table left in place for
  // archeology but no longer surfaced.
  {
    key: "monthly_expenses",
    title: "7. Monthly Expenses",
    description:
      "Two-row header: category labels (City Manager / Marketing / Equipment) above Apr/May/Jun. The 'Q2 Category Totals' group is skipped. Includes the Corporate row. Upserts by (city, month).",
    expectedColumns:
      "Category row above month row. Month row contains City + Apr/May/Jun (repeated under each category)",
    importer: importMonthlyExpenses,
  },
  {
    key: "members",
    title: "8. Members",
    description:
      "Keeps every member row regardless of status (needed for the Stripe email→city lookup). City derived from member_id prefix (ATX/DFW/HOU/SATX/ATL/STL/OKC/ELP); unrecognized prefixes go to Deleted Account Revenue. Replaces all existing fin_members rows.",
    expectedColumns:
      "Member ID, Member Email, Status, First Name, Last Name, Phone Number, Member Activation Date, Membership Length, Price, Canceled At, Cancel Reason",
    importer: importMembers,
  },
  {
    key: "member_spots",
    title: "9. Member Spots",
    description:
      "Wide format → long. Upserts by (venue, month). Headers are matched on month + type (Member / DPP / Other).",
    expectedColumns:
      "Venue, City + 'Apr 2026 Member Spots', 'Apr 2026 DPP Spots', 'Apr 2026 Other Spots', …",
    importer: importMemberSpots,
  },
  {
    key: "commentary",
    title: "10. Commentary",
    description:
      "Key-value format. Reads the row where column A is 'Eyebrow' and the row where column A is 'Body' from column B. Updates the existing fin_commentary entry, or creates one if missing.",
    expectedColumns:
      "Two rows: 'Eyebrow,<text>' and 'Body,<text>' (anywhere in the file; the 'Label,Value' header is optional)",
    importer: importCommentary,
  },
];
