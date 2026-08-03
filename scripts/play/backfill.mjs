// One-time historical backfill of Google Play installs into app_downloads.
// Local Node script (not reachable in prod, can't be triggered by URL).
//
//   node scripts/play/backfill.mjs inspect          # STEP 1: list + sample, no writes
//   node scripts/play/backfill.mjs backfill         # every month, oldest → newest
//   node scripts/play/backfill.mjs month 202406     # a single YYYYMM
//
// CREDENTIAL: the Vercel var GOOGLE_PLAY_SA_KEY_B64 is *Sensitive*, so
// `vercel env pull` returns it empty by design — it cannot be fetched to a laptop.
// To run this locally, provide the key yourself, e.g.:
//   export GOOGLE_PLAY_SA_KEY_B64="$(base64 -i play-sa.json)"    # then run
// or set GOOGLE_PLAY_SA_KEY_B64 in .env.local. The key is decoded in memory only,
// never logged. Supabase creds come from .env.local.
//
// This mirrors the parser in src/lib/playInstallsSync.ts (kept in sync); the daily
// current-month ingest runs from that lib inside /api/sync/cron on Vercel.

import { JWT } from "google-auth-library";
import { createClient } from "@supabase/supabase-js";

try { process.loadEnvFile(".env.local"); } catch { /* env may be exported already */ }

const BUCKET = "pubsite_prod_5429940555756052907";
const PREFIX = "stats/installs/";
const PKG = "com.matchday_app";
const METRIC = "daily_user_installs";

function saKey() {
  const b64 = process.env.GOOGLE_PLAY_SA_KEY_B64;
  if (!b64 || !b64.trim()) {
    console.error(
      "GOOGLE_PLAY_SA_KEY_B64 is not set locally. The Vercel var is Sensitive and cannot be pulled — " +
        'provide it yourself, e.g. export GOOGLE_PLAY_SA_KEY_B64="$(base64 -i play-sa.json)". Refusing to fall back.',
    );
    process.exit(1);
  }
  const k = JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
  if (!k.client_email || !k.private_key) { console.error("SA JSON missing client_email/private_key."); process.exit(1); }
  return k;
}
async function token() {
  const k = saKey();
  const jwt = new JWT({ email: k.client_email, key: k.private_key, scopes: ["https://www.googleapis.com/auth/devstorage.read_only"] });
  const { token } = await jwt.getAccessToken();
  if (!token) { console.error("Could not get GCS token."); process.exit(1); }
  return token;
}
async function gcs(path, tok) {
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (res.status === 403) { console.error("403 from Play bucket — grant still propagating (up to 24h). Not a bad credential. Retry later."); process.exit(2); }
  return res;
}
async function listObjects(tok) {
  const names = []; let page = "";
  do {
    const q = new URLSearchParams({ prefix: PREFIX, maxResults: "1000" }); if (page) q.set("pageToken", page);
    const res = await gcs(`o?${q}`, tok); if (!res.ok) { console.error("list failed", res.status); process.exit(1); }
    const b = await res.json(); for (const it of b.items ?? []) names.push(it.name); page = b.nextPageToken ?? "";
  } while (page);
  return names;
}
async function download(name, tok) { const res = await gcs(`o/${encodeURIComponent(name)}?alt=media`, tok); if (!res.ok) { console.error("download failed", name, res.status); process.exit(1); } return Buffer.from(await res.arrayBuffer()); }
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).swap16().toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString("utf8");
  return buf.toString("utf8");
}
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c === "\r") {} else f += c; }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}
const col = (h, n) => h.map((x) => x.trim().toLowerCase()).indexOf(n.toLowerCase());
function pickInstallCol(h) { const i = col(h, "Daily User Installs"); if (i < 0) { console.error("No 'Daily User Installs' column. Header:", h.join(" | ")); process.exit(1); } return i; }
function files(names) {
  const out = [];
  for (const name of names) { const m = name.slice(PREFIX.length).match(/^installs_(.+)_(\d{6})_overview\.csv$/i); if (m) out.push({ name, pkg: m[1], ym: m[2] }); }
  return out.sort((a, b) => a.ym.localeCompare(b.ym));
}
function parseOverview(buf) {
  const t = parseCsv(decode(buf)); if (!t.length) return { header: [], rows: [], pkgs: new Set() };
  const h = t[0], di = col(h, "Date"), pi = col(h, "Package Name"), vi = pickInstallCol(h);
  const pkgs = new Set(), rows = [];
  for (const r of t.slice(1)) { const p = (pi >= 0 ? r[pi] : PKG)?.trim(); if (p) pkgs.add(p); if (p && p !== PKG) continue;
    const d = (r[di] ?? "").trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const v = (r[vi] ?? "").trim(); const n = v === "" ? 0 : Number(v); if (!Number.isFinite(n)) continue;
    const raw = {}; h.forEach((x, i) => { raw[x.trim()] = (r[i] ?? "").trim(); });
    rows.push({ period_date: d, count: Math.max(0, Math.round(n)), raw }); }
  return { header: h, rows, pkgs };
}
function sb() { const u = process.env.NEXT_PUBLIC_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!u || !k) { console.error("Missing Supabase env."); process.exit(1); } return createClient(u, k, { auth: { persistSession: false } }); }
async function upsert(client, rows) {
  if (!rows.length) return 0;
  const payload = rows.map((r) => ({ platform: "android", package: PKG, metric: METRIC, period_grain: "day", period_date: r.period_date, count: r.count, source: "play_console_gcs", raw: r.raw, ingested_at: new Date().toISOString() }));
  const { error } = await client.from("app_downloads").upsert(payload, { onConflict: "platform,package,metric,period_grain,period_date" });
  if (error) { console.error("upsert failed:", error.message); process.exit(1); }
  return payload.length;
}
function gaps(days) {
  if (days.length < 2) return [];
  const g = []; for (let i = 1; i < days.length; i++) { const a = new Date(days[i - 1]), b = new Date(days[i]); const diff = (b - a) / 86400000; if (diff > 1) g.push(`${days[i - 1]}→${days[i]} (${diff - 1} missing)`); }
  return g;
}

const cmd = process.argv[2] || "inspect";
const tok = await token();

if (cmd === "inspect") {
  const fs = files(await listObjects(tok));
  console.log("overview files:", fs.length);
  for (const f of fs) console.log(" ", f.ym, f.name);
  const pkgs = [...new Set(fs.map((f) => f.pkg))];
  console.log("packages:", pkgs.join(", "), pkgs.length === 1 ? "(single ✓)" : "*** MULTIPLE — STOP ***");
  console.log("earliest:", fs[0]?.ym, "latest:", fs.at(-1)?.ym);
  if (fs.length) {
    const buf = await download(fs.at(-1).name, tok);
    const enc = buf[0] === 0xff && buf[1] === 0xfe ? "UTF-16LE(BOM)" : buf[0] === 0xef ? "UTF-8(BOM)" : "UTF-8";
    console.log("latest file encoding:", enc);
    console.log("first 200 bytes hex:", buf.slice(0, 200).toString("hex"));
    const t = parseCsv(decode(buf));
    console.log("HEADER:", JSON.stringify(t[0]));
    console.log("install-flavoured cols:", t[0].map((h, i) => ({ h: h.trim(), i })).filter((c) => /install|units/i.test(c.h)).map((c) => c.h).join(" | "));
    for (const r of t.slice(1, 4)) console.log("ROW:", JSON.stringify(r));
    // Step 2: sum each install column over this (latest) month.
    const h = t[0];
    for (const c of h.map((x, i) => [x.trim(), i]).filter(([n]) => /install|units/i.test(n))) {
      let s = 0; for (const r of t.slice(1)) { const v = Number((r[c[1]] ?? "").trim()); if (Number.isFinite(v)) s += v; }
      console.log(`  Σ ${c[0]} = ${s}`);
    }
  }
} else if (cmd === "backfill") {
  const client = sb(); const fs = files(await listObjects(tok));
  console.log("backfilling", fs.length, "months oldest→newest");
  for (const f of fs) {
    const { rows, pkgs } = parseOverview(await download(f.name, tok));
    const second = [...pkgs].filter((p) => p !== PKG);
    if (second.length) { console.error(`STOP: ${f.ym} has second package(s): ${second.join(", ")}`); process.exit(1); }
    const n = await upsert(client, rows);
    const days = rows.map((r) => r.period_date).sort();
    const g = gaps(days);
    console.log(`  ${f.ym}: ${n} rows${n === 0 ? "  *** ZERO ***" : ""}${g.length ? "  GAPS: " + g.join(", ") : ""}`);
  }
} else if (cmd === "month") {
  const ym = process.argv[3]; if (!/^\d{6}$/.test(ym || "")) { console.error("usage: month YYYYMM"); process.exit(1); }
  const client = sb();
  const { rows } = parseOverview(await download(`${PREFIX}installs_${PKG}_${ym}_overview.csv`, tok));
  console.log(`${ym}: ${await upsert(client, rows)} rows`);
} else { console.error("commands: inspect | backfill | month YYYYMM"); process.exit(1); }
