import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { normalizeMatchName } from "./venueNormalization";
import { computeMonthlySnapshot } from "./membershipStats";
import { CITIES } from "./types";

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

// ===== Delete helpers =====

async function deleteAll(table: string): Promise<void> {
  const { error } = await supabase.from(table).delete().gt("id", 0);
  if (error) throw new Error(error.message);
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
  sourceFileName?: string,
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

  // Auxiliary monthly snapshot — best-effort. The fin_members rows
  // (source of truth) are already committed above, so a snapshot
  // failure shouldn't fail the upload.
  try {
    const snap = computeMonthlySnapshot(parsed, CITIES, new Date(), sourceFileName);
    const { error: snapErr } = await supabase
      .from("members_monthly_snapshots")
      .upsert(snap, { onConflict: "month" });
    if (snapErr) console.warn("Members snapshot upsert failed:", snapErr.message);
  } catch (e) {
    console.warn("Members snapshot computation failed:", e);
  }

  return { count: parsed.length };
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
