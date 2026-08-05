// Google Play install ingest. Read-only against Play; the only writes are to our
// own app_downloads table. Node-only (uses the service-account key + service-role
// Supabase). Never import from a client component.
//
// CREDENTIAL: GOOGLE_PLAY_SA_KEY_B64 (base64 of the SA JSON), decoded at runtime
// only. It is never logged, echoed, returned, or put in an error message. If it
// is absent or empty we throw a clear message and DO NOT fall back to anything.
//
// BUCKET: gs://pubsite_prod_5429940555756052907/stats/installs/ — used verbatim
// (newer Play accounts dropped the "_rev_" segment; we do not "correct" it).
//
// We read via the GCS JSON API with a google-auth-library JWT (devstorage
// read-only scope) — no @google-cloud/storage dependency.

import "server-only";
import { JWT } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";

export const PLAY_BUCKET = "pubsite_prod_5429940555756052907";
export const PLAY_PREFIX = "stats/installs/";
export const PLAY_PACKAGE = "com.matchday_app";
// The chosen metric: the user-based first-install column (dedupes a player's
// phone+tablet to one, excludes reinstall events) — the closest counterpart to
// Apple's App Units. See pickInstallColumn() for the full reasoning.
export const PLAY_METRIC = "daily_user_installs";

export class PlayGrantPendingError extends Error {}

function saKey(): { client_email: string; private_key: string } {
  const b64 = process.env.GOOGLE_PLAY_SA_KEY_B64;
  if (!b64 || !b64.trim()) {
    throw new Error(
      "GOOGLE_PLAY_SA_KEY_B64 is not set (or empty) — cannot authenticate to Play. Refusing to fall back.",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
  } catch {
    // Deliberately does NOT include the decoded value.
    throw new Error("GOOGLE_PLAY_SA_KEY_B64 did not base64-decode to valid JSON.");
  }
  const k = json as { client_email?: string; private_key?: string };
  if (!k.client_email || !k.private_key) {
    throw new Error("Service-account JSON is missing client_email / private_key.");
  }
  return { client_email: k.client_email, private_key: k.private_key };
}

async function accessToken(): Promise<string> {
  const { client_email, private_key } = saKey();
  const jwt = new JWT({
    email: client_email,
    key: private_key,
    scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to obtain a GCS access token for the Play service account.");
  return token;
}

async function gcs(path: string, token: string): Promise<Response> {
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${PLAY_BUCKET}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 403) {
    throw new PlayGrantPendingError(
      "403 from the Play bucket. The 'View app information and download bulk reports' grant can take up to 24h to " +
        "propagate to the bucket — this is the expected state right after granting, not a bad credential. Retry later.",
    );
  }
  return res;
}

// List every stats/installs object (paginated).
async function listObjects(token: string): Promise<string[]> {
  const names: string[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ prefix: PLAY_PREFIX, maxResults: "1000" });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await gcs(`o?${q.toString()}`, token);
    if (!res.ok) throw new Error(`GCS list failed: ${res.status}`);
    const body = (await res.json()) as { items?: { name: string }[]; nextPageToken?: string };
    for (const it of body.items ?? []) names.push(it.name);
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return names;
}

// Diagnostic list: the RAW GCS list call with the verbatim HTTP status and error
// body preserved (unlike gcs(), which collapses 403 into a canned message). Used
// by the on-demand trigger route to report 403-grant-missing vs 404-bad-path vs
// success with the actual object names/dates. Never returns key material.
export async function listInstalls(): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  error?: string;
  objects?: { name: string; updated: string; size: string }[];
}> {
  let token: string;
  try {
    token = await accessToken();
  } catch (e) {
    // Auth failure (bad/empty key, JWT signing) — surface sanitized, no key bytes.
    return { ok: false, status: 0, statusText: "auth", error: e instanceof Error ? e.message : String(e) };
  }
  const objects: { name: string; updated: string; size: string }[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ prefix: PLAY_PREFIX, maxResults: "1000" });
    if (pageToken) q.set("pageToken", pageToken);
    const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${PLAY_BUCKET}/o?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, statusText: res.statusText, error: body.slice(0, 2000) };
    }
    const parsed = (await res.json()) as {
      items?: { name: string; updated: string; size: string }[];
      nextPageToken?: string;
    };
    for (const it of parsed.items ?? []) objects.push({ name: it.name, updated: it.updated, size: it.size });
    pageToken = parsed.nextPageToken ?? "";
  } while (pageToken);
  return { ok: true, status: 200, statusText: "OK", objects };
}

async function downloadBytes(objectName: string, token: string): Promise<Buffer> {
  const res = await gcs(`o/${encodeURIComponent(objectName)}?alt=media`, token);
  if (!res.ok) throw new Error(`GCS download failed for ${objectName}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Overview (un-dimensioned) install files: installs_<pkg>_YYYYMM_overview.csv
export type InstallFile = { name: string; ym: string; pkg: string };
export function parseInstallFiles(names: string[]): InstallFile[] {
  const out: InstallFile[] = [];
  for (const name of names) {
    const base = name.slice(PLAY_PREFIX.length);
    const m = base.match(/^installs_(.+)_(\d{6})_overview\.csv$/i);
    if (!m) continue;
    out.push({ name, pkg: m[1], ym: m[2] });
  }
  out.sort((a, b) => a.ym.localeCompare(b.ym));
  return out;
}

// Decode a Play statistics CSV. These are historically UTF-16LE with a BOM; we
// detect the BOM rather than assume, falling back to UTF-8.
export function decodeCsv(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).swap16().toString("utf16le");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString("utf8");
  return buf.toString("utf8");
}

// Minimal CSV parse (quoted fields, embedded commas/quotes).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}

// Choose the user-based first-install column. We match on normalized header
// names and refuse (throw) rather than guess if it is absent.
export function pickInstallColumn(header: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  const idx = norm.indexOf("daily user installs");
  if (idx >= 0) return idx;
  throw new Error(
    `Could not find the "Daily User Installs" column. Header was: [${header.join(" | ")}]. ` +
      "Not guessing a device-based or events column.",
  );
}

function findCol(header: string[], name: string): number {
  return header.map((h) => h.trim().toLowerCase()).indexOf(name.toLowerCase());
}

// Parse one overview file into android daily rows for the given package. The
// expected package is passed in (derived from the real filenames) rather than
// assumed — if it were hardcoded and the store's package differed, every row
// would be filtered out and we'd silently write zero.
export type DailyRow = { period_date: string; count: number; raw: Record<string, string> };
export function parseOverview(
  buf: Buffer,
  expectedPkg: string = PLAY_PACKAGE,
): { header: string[]; rows: DailyRow[]; packages: Set<string> } {
  const table = parseCsv(decodeCsv(buf));
  if (!table.length) return { header: [], rows: [], packages: new Set() };
  const header = table[0];
  const dateI = findCol(header, "Date");
  const pkgI = findCol(header, "Package Name");
  const valI = pickInstallColumn(header);
  if (dateI < 0) throw new Error(`No "Date" column in overview file. Header: [${header.join(" | ")}]`);
  const packages = new Set<string>();
  const rows: DailyRow[] = [];
  for (const r of table.slice(1)) {
    const pkg = (pkgI >= 0 ? r[pkgI] : expectedPkg)?.trim();
    if (pkg) packages.add(pkg);
    if (pkg && pkg !== expectedPkg) continue; // never sum a second package
    const date = (r[dateI] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rawVal = (r[valI] ?? "").trim();
    const count = rawVal === "" ? 0 : Number(rawVal);
    if (!Number.isFinite(count)) continue;
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { raw[h.trim()] = (r[i] ?? "").trim(); });
    rows.push({ period_date: date, count: Math.max(0, Math.round(count)), raw });
  }
  return { header, rows, packages };
}

// ── public operations ────────────────────────────────────────────────────────

// STEP 1 "look before you parse": list files + sample the latest overview.
export async function inspectBucket(): Promise<{
  files: InstallFile[];
  packages: string[];
  earliest: string | null;
  latest: string | null;
  latestFile: string | null;
  encoding: string;
  firstBytesHex: string;
  header: string[];
  firstRows: string[][];
  installColumns: { name: string; index: number }[];
  chosenColumn: string;
}> {
  const token = await accessToken();
  const names = await listObjects(token);
  const files = parseInstallFiles(names);
  const packages = [...new Set(files.map((f) => f.pkg))];
  const latest = files[files.length - 1] ?? null;
  let encoding = "n/a", firstBytesHex = "", header: string[] = [], firstRows: string[][] = [];
  let installColumns: { name: string; index: number }[] = [];
  if (latest) {
    const buf = await downloadBytes(latest.name, token);
    firstBytesHex = buf.slice(0, 200).toString("hex");
    encoding =
      buf[0] === 0xff && buf[1] === 0xfe ? "UTF-16LE (BOM)"
      : buf[0] === 0xfe && buf[1] === 0xff ? "UTF-16BE (BOM)"
      : buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? "UTF-8 (BOM)"
      : "UTF-8 (no BOM)";
    const table = parseCsv(decodeCsv(buf));
    header = table[0] ?? [];
    firstRows = table.slice(1, 4);
    installColumns = header
      .map((h, i) => ({ name: h.trim(), index: i }))
      .filter((c) => /install|units/i.test(c.name));
  }
  return {
    files, packages,
    earliest: files[0]?.ym ?? null,
    latest: latest?.ym ?? null,
    latestFile: latest?.name ?? null,
    encoding, firstBytesHex, header, firstRows,
    installColumns, chosenColumn: "Daily User Installs",
  };
}

async function upsertRows(
  supabase: SupabaseClient,
  rows: DailyRow[],
  pkg: string,
  sourceFile: string,
): Promise<number> {
  if (!rows.length) return 0;
  const at = new Date().toISOString();
  const payload = rows.map((r) => ({
    platform: "android",
    package: pkg,
    metric: PLAY_METRIC,
    period_grain: "day",
    period_date: r.period_date,
    count: r.count,
    source: "play_console_gcs",
    // Keep the source filename in raw so the ingested rows are self-describing
    // (which overview file each day came from) without a separate listing table.
    raw: { ...r.raw, _source_file: sourceFile },
    ingested_at: at,
  }));
  const { error } = await supabase
    .from("app_downloads")
    .upsert(payload, { onConflict: "platform,package,metric,period_grain,period_date" });
  if (error) throw new Error(`app_downloads upsert failed: ${error.message}`);
  return payload.length;
}

// From the REAL overview filenames, decide which package we ingest — never assume
// "com.matchday_app". Prefer the package whose name contains "matchday"; if there
// is exactly one, use it. null when there are no overview files at all.
export function deriveInstallPackage(files: InstallFile[]): string | null {
  const pkgs = [...new Set(files.map((f) => f.pkg))];
  if (!pkgs.length) return null;
  if (pkgs.length === 1) return pkgs[0];
  return pkgs.find((p) => /matchday/i.test(p)) ?? pkgs[0];
}

export type IngestSummary = {
  objects: { name: string; updated: string; size: string }[];
  packages: string[]; // every distinct package seen in the overview filenames
  chosenPackage: string | null;
  otherPackages: string[]; // packages present but NOT ingested (never summed in)
  availableMonths: string[]; // YYYYMM overview months for the chosen package
  ingestedMonths: string[];
  rowsWritten: number;
  perMonth: { ym: string; file: string; rows: number }[];
};

// List-driven ingest: given the ACTUAL objects in the bucket, derive the real
// package + available months from the filenames and ingest EVERY overview month
// by its real name — no constructed filenames. The current month is re-downloaded
// in full like every other month (idempotent upsert on the day key), so late
// restatements of earlier days overwrite cleanly. `now` is unused but kept in the
// signature so the caller still owns the clock if month-scoping is added later.
export async function ingestAllMonths(
  supabase: SupabaseClient,
  objects: { name: string; updated: string; size: string }[],
  _now: Date,
): Promise<IngestSummary> {
  const files = parseInstallFiles(objects.map((o) => o.name));
  const allPkgs = [...new Set(files.map((f) => f.pkg))];
  const chosen = deriveInstallPackage(files);
  const mine = chosen ? files.filter((f) => f.pkg === chosen) : [];
  const token = await accessToken();
  const perMonth: { ym: string; file: string; rows: number }[] = [];
  let rowsWritten = 0;
  for (const f of mine) {
    const buf = await downloadBytes(f.name, token);
    const { rows } = parseOverview(buf, chosen!);
    rowsWritten += await upsertRows(supabase, rows, chosen!, f.name.slice(PLAY_PREFIX.length));
    perMonth.push({ ym: f.ym, file: f.name, rows: rows.length });
  }
  return {
    objects,
    packages: allPkgs,
    chosenPackage: chosen,
    otherPackages: allPkgs.filter((p) => p !== chosen),
    availableMonths: mine.map((f) => f.ym).sort(),
    ingestedMonths: perMonth.map((p) => p.ym).sort(),
    rowsWritten,
    perMonth,
  };
}
