import { supabase } from "./supabase";

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

  await clearMonths(
    "fin_schedule",
    mapped.map((r) => r.month!),
  );

  const BATCH = 500;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const { error } = await supabase.from("fin_schedule").insert(chunk);
    if (error) throw new Error(error.message);
  }
  return {
    count: mapped.length,
    note: `Replaced ${[...new Set(mapped.map((r) => r.month!))].length} month(s).`,
  };
}

export async function importManagerPay(
  raw: string[][],
): Promise<ImportResult> {
  const detection = detectWideHeader(
    raw,
    [{ canonical: "City", required: true }],
    (h) => extractMonthLabel(h) !== null,
    1,
  );
  if ("error" in detection) throw new Error(detection.error);
  const { headerRowIndex, headerRow, fixedIndex } = detection;

  const cityIdx = fixedIndex["City"];
  const monthCols: { index: number; month: string }[] = [];
  for (let i = 0; i < headerRow.length; i++) {
    if (i === cityIdx) continue;
    const m = extractMonthLabel(headerRow[i]);
    if (m) monthCols.push({ index: i, month: m });
  }

  const longRows: { city: string; month: string; amount: number }[] = [];
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const row = raw[i] ?? [];
    const city = trim(row[cityIdx]);
    if (!city) continue;
    for (const mc of monthCols) {
      const amount = parseNum(row[mc.index]);
      if (amount === null) continue;
      longRows.push({ city, month: mc.month, amount });
    }
  }

  if (longRows.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No (city, month, amount) rows produced.`,
    );
  }

  const { error } = await supabase
    .from("fin_manager_pay")
    .upsert(longRows, { onConflict: "city,month" });
  if (error) throw new Error(error.message);
  return { count: longRows.length };
}

type ExpenseCategory = "city_manager" | "marketing" | "equipment";

function parseMonthlyExpenseHeader(
  header: string,
): { category: ExpenseCategory; month: string } | null {
  const lower = header.toLowerCase();
  let category: ExpenseCategory | null = null;
  if (lower.includes("city manager") || lower.includes("citymanager")) {
    category = "city_manager";
  } else if (lower.includes("marketing")) {
    category = "marketing";
  } else if (lower.includes("equipment")) {
    category = "equipment";
  }
  if (!category) return null;
  const month = extractMonthLabel(lower);
  if (!month) return null;
  return { category, month };
}

export async function importMonthlyExpenses(
  raw: string[][],
): Promise<ImportResult> {
  const detection = detectWideHeader(
    raw,
    [{ canonical: "City", required: true }],
    (h) => parseMonthlyExpenseHeader(h) !== null,
    1,
  );
  if ("error" in detection) throw new Error(detection.error);
  const { headerRowIndex, headerRow, fixedIndex } = detection;

  const cityIdx = fixedIndex["City"];
  const parsedHeaders: {
    index: number;
    parsed: { category: ExpenseCategory; month: string };
  }[] = [];
  for (let i = 0; i < headerRow.length; i++) {
    if (i === cityIdx) continue;
    const p = parseMonthlyExpenseHeader(headerRow[i] ?? "");
    if (p) parsedHeaders.push({ index: i, parsed: p });
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
  for (let i = headerRowIndex + 1; i < raw.length; i++) {
    const row = raw[i] ?? [];
    const city = trim(row[cityIdx]);
    if (!city) continue;
    for (const ph of parsedHeaders) {
      const num = parseNum(row[ph.index]);
      if (num === null) continue;
      const key = `${city}|${ph.parsed.month}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          city,
          month: ph.parsed.month,
          city_manager: 0,
          marketing: 0,
          equipment: 0,
        };
        byKey.set(key, entry);
      }
      entry[ph.parsed.category] = num;
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
    canonical: "status",
    aliases: ["Subscription Status"],
    required: true,
  },
  {
    canonical: "price_cents",
    aliases: ["Price Cents", "Price"],
    required: true,
  },
  { canonical: "email", required: false },
];

export async function importMembers(raw: string[][]): Promise<ImportResult> {
  const result = preprocessFixed(raw, MEMBERS_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows } = result;

  let totalConsidered = 0;
  let droppedNotActive = 0;
  let droppedZeroPrice = 0;
  let droppedNoCity = 0;
  const mapped: {
    member_id: string;
    status: string;
    price_cents: number;
    city: string;
    email: string | null;
  }[] = [];

  for (const r of rows) {
    const memberId = trim(r["member_id"]);
    if (!memberId) continue;
    totalConsidered++;
    const status = (trim(r["status"]) ?? "").toUpperCase();
    if (status !== "ACTIVE") {
      droppedNotActive++;
      continue;
    }
    const priceCents = parseInteger(r["price_cents"]) ?? 0;
    if (priceCents === 0) {
      droppedZeroPrice++;
      continue;
    }
    const city = deriveMemberCity(memberId);
    if (!city) {
      droppedNoCity++;
      continue;
    }
    mapped.push({
      member_id: memberId,
      status,
      price_cents: priceCents,
      city,
      email: trim(r["email"]),
    });
  }

  await deleteAll("fin_members");
  if (mapped.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < mapped.length; i += BATCH) {
      const chunk = mapped.slice(i, i + BATCH);
      const { error } = await supabase.from("fin_members").insert(chunk);
      if (error) throw new Error(error.message);
    }
  }
  return {
    count: mapped.length,
    note: `${totalConsidered} input rows · dropped ${droppedNotActive} non-ACTIVE, ${droppedZeroPrice} zero-price, ${droppedNoCity} unrecognized prefix.`,
  };
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

const COMMENTARY_SPEC: ColumnSpec[] = [
  { canonical: "Eyebrow", required: true },
  { canonical: "Body", required: true },
];

export async function importCommentary(
  raw: string[][],
): Promise<ImportResult> {
  const result = preprocessFixed(raw, COMMENTARY_SPEC);
  if ("error" in result) throw new Error(result.error);
  const { rows, headerRow } = result;

  if (rows.length === 0) {
    const detected = headerRow.filter((h) => h && h.trim()).join(" | ");
    throw new Error(
      `Detected header: "${detected}". No data row found below the header.`,
    );
  }
  const r = rows[0];
  const eyebrow = trim(r["Eyebrow"]);
  const body = trim(r["Body"]);
  if (!eyebrow || !body) {
    throw new Error("First data row needs both Eyebrow and Body filled in.");
  }

  await deleteAll("fin_commentary");
  const { error } = await supabase.from("fin_commentary").insert({
    eyebrow,
    body,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return { count: 1 };
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
  {
    key: "manager_pay",
    title: "6. Manager Pay",
    description:
      "Wide format → long. City + month columns (e.g. 'Apr 2026'). Upserts by (city, month).",
    expectedColumns: "City + month columns (Apr 2026, May 2026, …)",
    importer: importManagerPay,
  },
  {
    key: "monthly_expenses",
    title: "7. Monthly Expenses",
    description:
      "Wide format → long. Upserts by (city, month). Headers are matched on category + month.",
    expectedColumns:
      "City + 'City Manager Apr 2026', 'Marketing Apr 2026', 'Equipment Apr 2026', … (one per category × month)",
    importer: importMonthlyExpenses,
  },
  {
    key: "members",
    title: "8. Members",
    description:
      "Drops non-ACTIVE rows and rows with price_cents = 0. City derived from member_id prefix (ATX/DFW/HOU/SATX/ATL/STL/OKC/ELP). Replaces all existing fin_members rows.",
    expectedColumns: "member_id, status, price_cents, email",
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
    description: "Single row. Replaces the existing commentary entry.",
    expectedColumns: "Eyebrow, Body",
    importer: importCommentary,
  },
];
