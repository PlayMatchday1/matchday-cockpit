import { supabase } from "./supabase";

export type CsvRow = Record<string, string | undefined>;

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

function trim(v: string | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}

function parseNum(v: string | undefined): number | null {
  const t = trim(v);
  if (!t) return null;
  const cleaned = t.replace(/[$,]/g, "").replace(/[()]/g, "-");
  if (cleaned === "" || cleaned === "-") return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function parseInteger(v: string | undefined): number | null {
  const n = parseNum(v);
  if (n === null) return null;
  return Math.round(n);
}

function parseBool(v: string | undefined, defaultValue: boolean): boolean {
  const t = trim(v);
  if (!t) return defaultValue;
  const lower = t.toLowerCase();
  if (["true", "yes", "1", "y", "active"].includes(lower)) return true;
  if (["false", "no", "0", "n", "inactive"].includes(lower)) return false;
  return defaultValue;
}

function parseDate(v: string | undefined): string | null {
  const t = trim(v);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
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

function extractMonthLabel(s: string): string | null {
  const lower = s.toLowerCase();
  for (let i = 0; i < MONTH_KEYS.length; i++) {
    if (lower.includes(MONTH_KEYS[i])) {
      const yearMatch = lower.match(/20\d{2}/);
      const year = yearMatch ? yearMatch[0] : DEFAULT_YEAR;
      return `${MONTH_LABELS[i]} ${year}`;
    }
  }
  return null;
}

function deriveMemberCity(memberId: string): string | null {
  const upper = memberId.toUpperCase();
  for (const [prefix, city] of Object.entries(MEMBER_CITY_PREFIX)) {
    if (upper.startsWith(prefix)) return city;
  }
  return null;
}

function pickField(r: CsvRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = trim(r[k]);
    if (v) return v;
  }
  return null;
}

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

export async function importVenues(rows: CsvRow[]): Promise<ImportResult> {
  const mapped = rows
    .map((r) => ({
      venue_name: pickField(r, "Venue Name", "venue_name"),
      city: pickField(r, "City", "city"),
      billing_type: pickField(r, "Billing Type", "billing_type"),
      hourly_rate: parseNum(r["Hourly Rate"] ?? r["hourly_rate"]),
      monthly_flat: parseNum(r["Monthly Flat"] ?? r["monthly_flat"]),
      per_match_rate: parseNum(r["Per Match Rate"] ?? r["per_match_rate"]),
      max_spots: parseInteger(r["Max Spots"] ?? r["max_spots"]),
      notes: pickField(r, "Notes", "notes"),
      launch_date: parseDate(r["Launch Date"] ?? r["launch_date"]),
      is_active: parseBool(r["Is Active"] ?? r["is_active"], true),
    }))
    .filter((r) => r.venue_name && r.city && r.billing_type);

  if (mapped.length === 0) {
    throw new Error("No rows have Venue Name, City, and Billing Type.");
  }
  for (const r of mapped) {
    if (!["per_hour", "per_match", "monthly_flat"].includes(r.billing_type!)) {
      throw new Error(
        `Invalid Billing Type "${r.billing_type}" for ${r.venue_name}. Must be per_hour, per_match, or monthly_flat.`,
      );
    }
  }
  const { error } = await supabase
    .from("fin_venues")
    .upsert(mapped, { onConflict: "venue_name" });
  if (error) throw new Error(error.message);
  return { count: mapped.length };
}

export async function importPricing(rows: CsvRow[]): Promise<ImportResult> {
  const mapped = rows
    .map((r) => ({
      venue_name: pickField(r, "Venue Name", "venue_name"),
      city: pickField(r, "City", "city"),
      dpp_price: parseNum(r["DPP Price"] ?? r["dpp_price"]),
      member_price: parseNum(r["Member Price"] ?? r["member_price"]),
      notes: pickField(r, "Notes", "notes"),
    }))
    .filter(
      (r) =>
        r.venue_name &&
        r.city &&
        r.dpp_price !== null &&
        r.member_price !== null,
    );

  if (mapped.length === 0) {
    throw new Error(
      "No rows have Venue Name, City, DPP Price, and Member Price.",
    );
  }
  const { error } = await supabase
    .from("fin_pricing")
    .upsert(mapped, { onConflict: "venue_name" });
  if (error) throw new Error(error.message);
  return { count: mapped.length };
}

export async function importRevenue(rows: CsvRow[]): Promise<ImportResult> {
  const mapped = rows
    .map((r) => ({
      date: parseDate(r["Date"] ?? r["date"]),
      month: pickField(r, "Month", "month"),
      city: pickField(r, "City", "city"),
      venue: pickField(r, "Venue", "venue"),
      type: pickField(r, "Type", "type"),
      gross: parseNum(r["Gross"] ?? r["gross"]),
      fees: parseNum(r["Fees"] ?? r["fees"]) ?? 0,
      source: pickField(r, "Source", "source"),
      notes: pickField(r, "Notes", "notes"),
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
    throw new Error(
      "No rows have Date, Month, City, Type, Source, and Gross.",
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

export async function importExpenses(rows: CsvRow[]): Promise<ImportResult> {
  const mapped = rows
    .map((r) => ({
      date: parseDate(r["Date"] ?? r["date"]),
      month: pickField(r, "Month", "month"),
      city: pickField(r, "City", "city"),
      category: pickField(r, "Category", "category"),
      vendor: pickField(r, "Vendor", "vendor"),
      amount: parseNum(r["Amount"] ?? r["amount"]),
      notes: pickField(r, "Notes", "notes"),
    }))
    .filter(
      (r) =>
        r.date && r.month && r.city && r.category && r.amount !== null,
    );

  if (mapped.length === 0) {
    throw new Error("No rows have Date, Month, City, Category, and Amount.");
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

export async function importSchedule(rows: CsvRow[]): Promise<ImportResult> {
  const mapped = rows
    .map((r) => ({
      date: parseDate(r["Date"] ?? r["date"]),
      month: pickField(r, "Month", "month"),
      city: pickField(r, "City", "city"),
      venue: pickField(r, "Venue", "venue"),
      match_count: parseInteger(r["Match Count"] ?? r["match_count"]) ?? 1,
      total_hours: parseNum(r["Total Hours"] ?? r["total_hours"]),
      venue_cost: parseNum(r["Venue Cost"] ?? r["venue_cost"]),
      notes: pickField(r, "Notes", "notes"),
    }))
    .filter((r) => r.date && r.month && r.city && r.venue);

  if (mapped.length === 0) {
    throw new Error("No rows have Date, Month, City, and Venue.");
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

export async function importManagerPay(rows: CsvRow[]): Promise<ImportResult> {
  if (rows.length === 0) throw new Error("CSV is empty.");
  const headers = Object.keys(rows[0]);
  const monthCols: { header: string; month: string }[] = [];
  for (const h of headers) {
    if (h.toLowerCase().trim() === "city") continue;
    const month = extractMonthLabel(h);
    if (month) monthCols.push({ header: h, month });
  }
  if (monthCols.length === 0) {
    throw new Error("No month columns found (need headers like 'Apr 2026').");
  }

  const longRows: { city: string; month: string; amount: number }[] = [];
  for (const r of rows) {
    const city = pickField(r, "City", "city");
    if (!city) continue;
    for (const { header, month } of monthCols) {
      const amount = parseNum(r[header]);
      if (amount === null) continue;
      longRows.push({ city, month, amount });
    }
  }

  if (longRows.length === 0) {
    throw new Error("No valid (city, month, amount) rows produced.");
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
  if (lower.includes("city manager")) category = "city_manager";
  else if (lower.includes("marketing")) category = "marketing";
  else if (lower.includes("equipment")) category = "equipment";
  if (!category) return null;
  const month = extractMonthLabel(lower);
  if (!month) return null;
  return { category, month };
}

export async function importMonthlyExpenses(
  rows: CsvRow[],
): Promise<ImportResult> {
  if (rows.length === 0) throw new Error("CSV is empty.");
  const headers = Object.keys(rows[0]);
  const parsedHeaders = headers
    .map((h) => ({ header: h, parsed: parseMonthlyExpenseHeader(h) }))
    .filter(
      (
        x,
      ): x is { header: string; parsed: { category: ExpenseCategory; month: string } } =>
        x.parsed !== null,
    );
  if (parsedHeaders.length === 0) {
    throw new Error(
      "No category-month columns found (need headers like 'City Manager Apr 2026').",
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
  for (const r of rows) {
    const city = pickField(r, "City", "city");
    if (!city) continue;
    for (const { header, parsed } of parsedHeaders) {
      const num = parseNum(r[header]);
      if (num === null) continue;
      const key = `${city}|${parsed.month}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          city,
          month: parsed.month,
          city_manager: 0,
          marketing: 0,
          equipment: 0,
        };
        byKey.set(key, entry);
      }
      entry[parsed.category] = num;
    }
  }

  const longRows = [...byKey.values()];
  if (longRows.length === 0) {
    throw new Error("No valid rows produced.");
  }
  const { error } = await supabase
    .from("fin_monthly_expenses")
    .upsert(longRows, { onConflict: "city,month" });
  if (error) throw new Error(error.message);
  return { count: longRows.length };
}

export async function importMembers(rows: CsvRow[]): Promise<ImportResult> {
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
    const memberId =
      pickField(r, "member_id", "Customer ID", "ID", "id") ?? null;
    if (!memberId) continue;
    totalConsidered++;
    const status = (
      pickField(r, "status", "Status", "Subscription Status") ?? ""
    ).toUpperCase();
    if (status !== "ACTIVE") {
      droppedNotActive++;
      continue;
    }
    const priceCents =
      parseInteger(
        r["price_cents"] ?? r["Price Cents"] ?? r["price"] ?? r["Price"],
      ) ?? 0;
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
      email: pickField(r, "email", "Email"),
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
  rows: CsvRow[],
): Promise<ImportResult> {
  if (rows.length === 0) throw new Error("CSV is empty.");
  const headers = Object.keys(rows[0]);
  const parsedHeaders = headers
    .map((h) => ({ header: h, parsed: parseMemberSpotsHeader(h) }))
    .filter(
      (
        x,
      ): x is { header: string; parsed: { month: string; type: SpotsType } } =>
        x.parsed !== null,
    );
  if (parsedHeaders.length === 0) {
    throw new Error(
      "No month-type columns found (need headers like 'Apr 2026 Member Spots').",
    );
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
  for (const r of rows) {
    const venue = pickField(r, "Venue", "venue");
    const city = pickField(r, "City", "city");
    if (!venue || !city) continue;
    for (const { header, parsed } of parsedHeaders) {
      const num = parseInteger(r[header]);
      if (num === null) continue;
      const key = `${venue}|${parsed.month}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          venue,
          city,
          month: parsed.month,
          member_spots: 0,
          dpp_spots: 0,
          other_spots: 0,
        };
        byKey.set(key, entry);
      }
      if (parsed.type === "member") entry.member_spots = num;
      else if (parsed.type === "dpp") entry.dpp_spots = num;
      else entry.other_spots = num;
    }
  }

  const longRows = [...byKey.values()];
  if (longRows.length === 0) {
    throw new Error("No valid rows produced.");
  }
  const { error } = await supabase
    .from("fin_member_spots")
    .upsert(longRows, { onConflict: "venue,month" });
  if (error) throw new Error(error.message);
  return { count: longRows.length };
}

export async function importCommentary(
  rows: CsvRow[],
): Promise<ImportResult> {
  if (rows.length === 0) throw new Error("CSV is empty.");
  const r = rows[0];
  const eyebrow = pickField(r, "Eyebrow", "eyebrow");
  const body = pickField(r, "Body", "body");
  if (!eyebrow || !body) {
    throw new Error("First row needs Eyebrow and Body columns.");
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
  importer: (rows: CsvRow[]) => Promise<ImportResult>;
};

export const FINANCE_IMPORTERS: ImporterConfig[] = [
  {
    key: "venues",
    title: "1. Venues",
    description: "Upserts by Venue Name. Re-runnable.",
    expectedColumns:
      "Venue Name, City, Billing Type (per_hour | per_match | monthly_flat), Hourly Rate, Monthly Flat, Per Match Rate, Max Spots, Notes, Launch Date, Is Active",
    importer: importVenues,
  },
  {
    key: "pricing",
    title: "2. Pricing",
    description: "Upserts by Venue Name. Re-runnable.",
    expectedColumns: "Venue Name, City, DPP Price, Member Price, Notes",
    importer: importPricing,
  },
  {
    key: "revenue",
    title: "3. Revenue",
    description:
      "Replaces all rows for the months covered by the CSV, then inserts new rows. Re-runnable.",
    expectedColumns:
      "Date, Month, City, Venue, Type (DPP | Membership | Private Rental), Gross, Fees, Source (Stripe | Venmo | PROJECTION | Manual), Notes",
    importer: importRevenue,
  },
  {
    key: "expenses",
    title: "4. Expenses",
    description:
      "Replaces all rows for the months covered by the CSV, then inserts new rows. Re-runnable.",
    expectedColumns:
      "Date, Month, City, Category, Vendor, Amount, Notes",
    importer: importExpenses,
  },
  {
    key: "schedule",
    title: "5. Schedule",
    description:
      "Replaces all rows for the months covered by the CSV, then inserts new rows. Re-runnable.",
    expectedColumns:
      "Date, Month, City, Venue, Match Count, Total Hours, Venue Cost, Notes",
    importer: importSchedule,
  },
  {
    key: "manager_pay",
    title: "6. Manager Pay",
    description:
      "Wide format → long. City + month columns (e.g. 'Apr 2026'). Upserts by (city, month).",
    expectedColumns: "City, Apr 2026, May 2026, Jun 2026 (any month columns)",
    importer: importManagerPay,
  },
  {
    key: "monthly_expenses",
    title: "7. Monthly Expenses",
    description:
      "Wide format → long. Upserts by (city, month). Headers are matched on category + month.",
    expectedColumns:
      "City, City Manager Apr 2026, Marketing Apr 2026, Equipment Apr 2026, … (one per category × month)",
    importer: importMonthlyExpenses,
  },
  {
    key: "members",
    title: "8. Members",
    description:
      "Slim copy from Stripe. Drops non-ACTIVE rows and rows with price_cents = 0. City derived from member_id prefix (ATX/DFW/HOU/SATX/ATL/STL/OKC/ELP). Replaces all existing fin_members rows.",
    expectedColumns: "member_id, status, price_cents, email",
  importer: importMembers,
  },
  {
    key: "member_spots",
    title: "9. Member Spots",
    description:
      "Wide format → long. Upserts by (venue, month). Headers are matched on month + type (Member / DPP / Other).",
    expectedColumns:
      "Venue, City, Apr 2026 Member Spots, Apr 2026 DPP Spots, Apr 2026 Other Spots, … (one per month × type)",
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
