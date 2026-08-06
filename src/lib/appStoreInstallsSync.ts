// Apple App Store install ingest — the iOS mirror of playInstallsSync.ts. Reads
// App Store Connect Sales reports for our vendor number and writes app-download
// "Units" to app_downloads as platform='ios'. Read-only against Apple; the only
// writes are to our own app_downloads table. Node-only. Never import from a client
// component.
//
// CREDENTIALS (Vercel env, decoded at runtime only, NEVER logged/echoed/returned):
//   APP_STORE_CONNECT_ISSUER_ID   — team issuer id (JWT `iss`)
//   APP_STORE_CONNECT_KEY_ID      — the API key's id (JWT `kid`)
//   APP_STORE_CONNECT_P8_B64      — base64 of the .p8 EC private key (ES256 signer)
//   APP_STORE_CONNECT_VENDOR_NUMBER — Sales & Trends vendor number
// The key has the "Sales and Reports" role (enough for /v1/salesReports).
//
// AUTH: an ES256 JWT signed with the .p8, minted PER RUN (exp 15m) and never
// cached anywhere persistent. Signed with Node's crypto (dsaEncoding ieee-p1363
// gives the raw R||S JOSE signature) — no JWT dependency, and the key bytes never
// leave this module.
//
// THE METRIC (report this, don't conflate with Google): we sum the Sales SUMMARY
// report's "Units" for first-download Product Type Identifiers only (see
// APP_UNIT_PRODUCT_TYPES) — i.e. new app downloads, excluding updates (7*) and
// in-app purchases (IA*). This is Apple's Sales "Units" for app installs. It is
// NOT identical to Google's Play "Daily User Installs" (which is user-based and
// dedupes a person's multiple devices), nor to App Analytics "App Units" (unique
// first-time downloads by Apple ID). Store them per-platform, never summed as if
// equivalent.

import "server-only";
import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  createHash,
} from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";

export const APPLE_PLATFORM = "ios";
export const APPLE_METRIC = "app_units";
// Apple serves DAILY sales reports for roughly the last 365 days.
export const APPLE_RETENTION_DAYS = 365;
// Trailing days re-fetched in full every run so late restatements overwrite.
const TRAILING_DAYS = 35;
// Hard ceiling on fetches per run (backstop; normal runs do trailing + gaps).
const MAX_FETCHES = 420;

// First-download Product Type Identifiers in the Sales SUMMARY report. Updates
// (7, 7F, 7T, 7E) and IAPs (IA*) are deliberately excluded so this counts NEW
// installs. Kept as a set so unexpected types are reported, never silently summed.
const APP_UNIT_PRODUCT_TYPES = new Set([
  "1", "1F", "1T", "1E", "1EP", "1EU", "1EF", "F1", "1T1",
]);

export class AppleAuthError extends Error {}

// UUID (issuer id) and 10-char alphanumeric (key id) shapes, per Apple.
const ISSUER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_RE = /^[A-Z0-9]{10}$/i;

function creds(): { issuerId: string; keyId: string; p8: string; vendor: string } {
  // Trim AT THE READ SITE so nothing downstream can pick up the raw value. A
  // trailing newline/space on APP_STORE_CONNECT_ISSUER_ID made the `iss` claim 37
  // chars → Apple 401 even though the token was correctly signed. Trim ends only —
  // a genuinely malformed value must still fail the shape assertions below.
  const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID?.trim();
  const keyId = process.env.APP_STORE_CONNECT_KEY_ID?.trim();
  const p8b64 = process.env.APP_STORE_CONNECT_P8_B64?.trim();
  const vendor = process.env.APP_STORE_CONNECT_VENDOR_NUMBER?.trim();
  if (!issuerId || !keyId || !p8b64 || !vendor) {
    throw new AppleAuthError(
      "App Store Connect credentials are not fully set (need ISSUER_ID, KEY_ID, P8_B64, VENDOR_NUMBER).",
    );
  }
  // Shape assertions — fail LOUDLY before any HTTP call, naming the bad var and its
  // length (never its value), so a malformed credential can't become an opaque 401.
  if (!ISSUER_RE.test(issuerId)) {
    throw new AppleAuthError(`APP_STORE_CONNECT_ISSUER_ID is malformed (expected a 36-char UUID; got length ${issuerId.length}).`);
  }
  if (!KEY_ID_RE.test(keyId)) {
    throw new AppleAuthError(`APP_STORE_CONNECT_KEY_ID is malformed (expected 10 alphanumerics; got length ${keyId.length}).`);
  }
  let p8: string;
  try {
    p8 = Buffer.from(p8b64, "base64").toString("utf8");
  } catch {
    throw new AppleAuthError("APP_STORE_CONNECT_P8_B64 did not base64-decode."); // no key bytes in message
  }
  if (!p8.includes("BEGIN PRIVATE KEY")) {
    throw new AppleAuthError("Decoded APP_STORE_CONNECT_P8_B64 is not a PEM private key.");
  }
  return { issuerId, keyId, p8, vendor };
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Mint a fresh ES256 JWT. Never cached. The signature is raw R||S (ieee-p1363),
// which is exactly the JOSE format App Store Connect expects.
export function mintToken(): { token: string; vendor: string } {
  const { issuerId, keyId, p8, vendor } = creds();
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64url({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64url({
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  })}`;
  const sig = cryptoSign("sha256", Buffer.from(signingInput), { key: p8, dsaEncoding: "ieee-p1363" });
  return { token: `${signingInput}.${sig.toString("base64url")}`, vendor };
}

// TEMPORARY diagnostic (removed once the 401 is resolved). Builds a real token
// and reports its SHAPE — never the .p8 bytes or any base64 of it. The private key
// is only used to sign + derive the (safe) public key; it is never returned.
export function buildTokenDiagnostic(): { diag: Record<string, unknown>; token: string } {
  const { issuerId, keyId, p8 } = creds();
  const rawKeyId = process.env.APP_STORE_CONNECT_KEY_ID ?? "";
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64url({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64url({
    iss: issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  })}`;
  const sig = cryptoSign("sha256", Buffer.from(signingInput), { key: p8, dsaEncoding: "ieee-p1363" });
  const token = `${signingInput}.${sig.toString("base64url")}`;

  const parts = token.split(".");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

  // iss SHAPE (not the value)
  const iss = String(payload.iss ?? "");
  const positionsOfHyphens: number[] = [];
  for (let i = 0; i < iss.length; i++) if (iss[i] === "-") positionsOfHyphens.push(i);
  const issShape = {
    len: iss.length,
    hyphenCount: positionsOfHyphens.length,
    positionsOfHyphens,
    matchesUuidV4Regex: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(iss),
    upperCaseCount: (iss.match(/[A-Z]/g) ?? []).length,
  };

  const kid = String(header.kid ?? "");
  const keyIdShape = {
    len: kid.length,
    hasWhitespace: /\s/.test(kid),
    hasNewline: /[\r\n]/.test(kid),
    isAlnum10: /^[A-Za-z0-9]{10}$/.test(kid),
  };

  const priv = createPrivateKey({ key: p8, format: "pem" });
  const details = priv.asymmetricKeyDetails as { namedCurve?: string } | undefined;
  const pub = createPublicKey(priv);
  const spkiDer = pub.export({ type: "spki", format: "der" }) as Buffer;

  const diag: Record<string, unknown> = {
    header,
    claims: { ...payload, iss: issShape },
    kidMatchesEnv: kid === rawKeyId.trim(),
    keyIdShape,
    expMinusIat: (payload.exp as number) - (payload.iat as number),
    segmentCount: parts.length,
    sigByteLength: sig.length,
    p8: {
      decodedLength: p8.length,
      startsWithPkcs8Header: p8.startsWith("-----BEGIN PRIVATE KEY-----"),
      endsWithPkcs8Footer: p8.trimEnd().endsWith("-----END PRIVATE KEY-----"),
      hasCrLf: /\r\n/.test(p8),
      keyType: priv.asymmetricKeyType, // "ec"
      namedCurve: details?.namedCurve, // "prime256v1"
      publicKeySha256: createHash("sha256").update(spkiDer).digest("hex"), // PUBLIC key only
    },
    selfVerify: cryptoVerify("sha256", Buffer.from(signingInput), { key: pub, dsaEncoding: "ieee-p1363" }, sig),
  };
  return { diag, token };
}

const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

// TEMPORARY diagnostic — probe salesReports for specific dates and return the RAW
// status + verbatim body (Apple's 404 text distinguishes "no sales" from a bad
// vendor/filter) + decompressed row count. Vendor + token never returned.
export async function probeSalesDays(
  dates: string[],
): Promise<{ date: string; status: number; contentType: string | null; rowCount: number | null; body: string }[]> {
  const { token, vendor } = mintToken();
  const out: { date: string; status: number; contentType: string | null; rowCount: number | null; body: string }[] = [];
  for (const date of dates) {
    const q = new URLSearchParams({
      "filter[frequency]": "DAILY",
      "filter[reportType]": "SALES",
      "filter[reportSubType]": "SUMMARY",
      "filter[vendorNumber]": vendor,
      "filter[reportDate]": date,
      "filter[version]": "1_1",
    });
    const res = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/a-gzip" },
    });
    const contentType = res.headers.get("content-type");
    let body = "";
    let rowCount: number | null = null;
    if (res.ok) {
      const gz = Buffer.from(await res.arrayBuffer());
      let tsv: string;
      try {
        tsv = gunzipSync(gz).toString("utf8");
      } catch {
        tsv = gz.toString("utf8");
      }
      rowCount = tsv.split("\n").filter((l) => l.length > 0).length - 1; // minus header
      body = tsv.slice(0, 300);
    } else {
      body = (await res.text().catch(() => "")).slice(0, 300); // Apple's JSON error, verbatim
    }
    out.push({ date, status: res.status, contentType, rowCount, body });
  }
  return out;
}

// ── Sales report parse ───────────────────────────────────────────────────────
export type DaySales = {
  units: number; // summed first-download Units
  byType: Record<string, number>; // Units per Product Type Identifier (transparency)
  skus: string[];
};

export function parseSalesTsv(tsv: string): DaySales {
  const lines = tsv.split("\n").filter((l) => l.length > 0);
  if (!lines.length) return { units: 0, byType: {}, skus: [] };
  const header = lines[0].split("\t").map((h) => h.trim());
  const iUnits = header.indexOf("Units");
  const iType = header.indexOf("Product Type Identifier");
  const iSku = header.indexOf("SKU");
  if (iUnits < 0 || iType < 0) {
    throw new Error(`Sales report missing Units/Product Type columns. Header: [${header.join(" | ")}]`);
  }
  let units = 0;
  const byType: Record<string, number> = {};
  const skus = new Set<string>();
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const type = (c[iType] ?? "").trim();
    const n = Number((c[iUnits] ?? "").trim());
    if (!type || !Number.isFinite(n)) continue;
    byType[type] = (byType[type] ?? 0) + n;
    if (APP_UNIT_PRODUCT_TYPES.has(type)) {
      units += n;
      if (iSku >= 0 && c[iSku]) skus.add(c[iSku].trim());
    }
  }
  return { units: Math.max(0, Math.round(units)), byType, skus: [...skus] };
}

// ── one day fetch ────────────────────────────────────────────────────────────
type DayResult =
  | { kind: "data"; sales: DaySales }
  | { kind: "no-sales" } // Apple has no report for this day (0 installs) — still within retention
  | { kind: "beyond-retention" }
  | { kind: "auth-error"; status: number; error: string };

async function fetchSalesDay(token: string, vendor: string, dateISO: string): Promise<DayResult> {
  const q = new URLSearchParams({
    "filter[frequency]": "DAILY",
    "filter[reportType]": "SALES",
    "filter[reportSubType]": "SUMMARY",
    "filter[vendorNumber]": vendor,
    "filter[reportDate]": dateISO,
    "filter[version]": "1_1",
  });
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${q.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/a-gzip" },
  });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    return { kind: "auth-error", status: res.status, error: body.slice(0, 1200) };
  }
  if (res.status === 404) {
    // Apple returns 404 both for "no sales that day" and "date outside the report
    // window". The JSON error body distinguishes them.
    const body = await res.text().catch(() => "");
    if (/available|not available|older than|last 365|report is not/i.test(body)) return { kind: "beyond-retention" };
    return { kind: "no-sales" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { kind: "auth-error", status: res.status, error: body.slice(0, 1200) };
  }
  const gz = Buffer.from(await res.arrayBuffer());
  let tsv: string;
  try {
    tsv = gunzipSync(gz).toString("utf8");
  } catch {
    tsv = gz.toString("utf8"); // some responses arrive already-decompressed
  }
  return { kind: "data", sales: parseSalesTsv(tsv) };
}

// ── upsert ───────────────────────────────────────────────────────────────────
async function upsertDay(sb: SupabaseClient, dateISO: string, vendor: string, sales: DaySales | null): Promise<void> {
  const { error } = await sb.from("app_downloads").upsert(
    {
      platform: APPLE_PLATFORM,
      package: `apple:${vendor}`, // vendor-scoped so a second app can't be summed in
      metric: APPLE_METRIC,
      period_grain: "day",
      period_date: dateISO,
      count: sales ? sales.units : 0,
      source: "app_store_connect",
      raw: sales ? { byType: sales.byType, skus: sales.skus } : { byType: {}, skus: [], noReport: true },
      ingested_at: new Date().toISOString(),
    },
    { onConflict: "platform,package,metric,period_grain,period_date" },
  );
  if (error) throw new Error(`app_downloads(ios) upsert failed: ${error.message}`);
}

// ── public op: backfill every available day + re-fetch the trailing window ─────
export type AppleIngestSummary = {
  vendor: string;
  daysFetched: number;
  daysWithData: number;
  rowsWritten: number;
  unitsTotal: number;
  earliest: string | null;
  latest: string | null;
  retentionEdge: string | null; // oldest date Apple refused (retention boundary), if hit
  productTypeTotals: Record<string, number>; // union across the run, for the report
};

export async function ingestAppStore(sb: SupabaseClient, now: Date): Promise<AppleIngestSummary> {
  const { token, vendor } = mintToken();

  // Which ios days do we already have? Re-fetch the trailing window regardless;
  // only backfill OLDER days we're missing, so a run stays bounded after the first.
  const { data: existing } = await sb
    .from("app_downloads")
    .select("period_date")
    .eq("platform", APPLE_PLATFORM)
    .eq("period_grain", "day");
  const have = new Set((existing ?? []).map((r) => r.period_date as string));

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let daysFetched = 0,
    daysWithData = 0,
    rowsWritten = 0,
    unitsTotal = 0;
  let earliest: string | null = null,
    latest: string | null = null,
    retentionEdge: string | null = null;
  const productTypeTotals: Record<string, number> = {};

  for (let back = 1; back <= APPLE_RETENTION_DAYS + 2 && daysFetched < MAX_FETCHES; back++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - back);
    const dateISO = ymd(d);
    const inTrailing = back <= TRAILING_DAYS;
    if (!inTrailing && have.has(dateISO)) continue; // already backfilled, outside restatement window

    const r = await fetchSalesDay(token, vendor, dateISO);
    daysFetched++;
    if (r.kind === "auth-error") {
      throw new AppleAuthError(`App Store Connect ${r.status}: ${r.error || "request failed"}`);
    }
    if (r.kind === "beyond-retention") {
      retentionEdge = dateISO;
      break;
    }
    if (r.kind === "no-sales") {
      await upsertDay(sb, dateISO, vendor, null); // continuous 0-install day
      rowsWritten++;
      earliest = dateISO;
      if (!latest) latest = dateISO;
      continue;
    }
    // data
    await upsertDay(sb, dateISO, vendor, r.sales);
    rowsWritten++;
    daysWithData++;
    unitsTotal += r.sales.units;
    for (const [t, n] of Object.entries(r.sales.byType)) productTypeTotals[t] = (productTypeTotals[t] ?? 0) + n;
    earliest = dateISO;
    if (!latest) latest = dateISO;
  }

  return {
    vendor,
    daysFetched,
    daysWithData,
    rowsWritten,
    unitsTotal,
    earliest,
    latest,
    retentionEdge,
    productTypeTotals,
  };
}
