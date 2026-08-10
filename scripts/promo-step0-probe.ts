// PHASE 18a — STEP 0. Four READ-ONLY production GETs that gate the Promo Codes build.
// No writes. Uses the existing production read client (getMatchdayApiClient), which mints
// its own JWT from env and NEVER exposes it — this script only ever prints response
// bodies (promo CONFIG rows, not user PII) and HTTP status numbers. Never logs the token
// or an Authorization header.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/promo-step0-probe.ts
import { fetchMatchDayJson, MatchdayApiError } from "@/lib/matchdayApi";

process.loadEnvFile(".env.local");

// Pick whichever complete PRODUCTION admin cred set is present locally. The read/sync set
// (MATCHDAY_API_*) is Vercel-wired and often absent from .env.local; the write set
// (MATCHDAY_PROD_API_*) is the local-only, hand-run-probe set (docs/matchday-api-facts.md).
// A GET is a read whichever admin signs it. We print only WHICH set — never the values.
const BASE = "https://playmatchday.herokuapp.com";
type CredSet = { name: string; email?: string; password?: string; base: string };
const CANDIDATES: CredSet[] = [
  { name: "MATCHDAY_API_*", email: process.env.MATCHDAY_API_EMAIL, password: process.env.MATCHDAY_API_PASSWORD, base: process.env.MATCHDAY_API_BASE_URL ?? BASE },
  { name: "MATCHDAY_PROD_API_*", email: process.env.MATCHDAY_PROD_API_EMAIL, password: process.env.MATCHDAY_PROD_API_PASSWORD, base: process.env.MATCHDAY_PROD_BASE_URL ?? BASE },
];
const creds = CANDIDATES.find((c) => c.email && c.password);
if (!creds) { console.error("No complete prod cred set found locally (need MATCHDAY_API_* or MATCHDAY_PROD_API_* EMAIL+PASSWORD in .env.local)."); process.exit(1); }

let token: string | null = null;
async function signIn(): Promise<string> {
  const j = await fetchMatchDayJson<Record<string, unknown>>(new URL("/auth/signin", creds!.base).toString(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds!.email, password: creds!.password }),
  });
  const t = (j.accessToken ?? j.access_token ?? (j.data as Record<string, unknown>)?.accessToken ?? (j.data as Record<string, unknown>)?.access_token) as string | undefined;
  if (!t) throw new Error("sign-in returned no accessToken");
  return t;
}
async function get<T = unknown>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  if (!token) token = await signIn();
  const url = new URL(path, creds!.base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return fetchMatchDayJson<T>(url.toString(), { headers: { Authorization: `Bearer ${token}` } }, {
    refreshAuth: async () => { token = await signIn(); return { Authorization: `Bearer ${token}` }; },
  });
}

type Row = Record<string, unknown>;
type ListResp = { data?: Row[]; totalItems?: number } & Record<string, unknown>;

const line = (s: string) => console.log(s);
async function statusOf(path: string, query: Record<string, string | number>): Promise<string> {
  try {
    const j = await get<ListResp>(path, query);
    const n = Array.isArray(j?.data) ? j.data.length : "?";
    return `200 OK (data.length=${n}, totalItems=${j?.totalItems ?? "absent"})`;
  } catch (e) {
    if (e instanceof MatchdayApiError) return `HTTP ${e.status} — ${e.bodySnippet.slice(0, 90)}`;
    return `ERROR ${(e as Error).message.slice(0, 90)}`;
  }
}

async function main() {
  line("================ STEP 0 — promo read probes (production, read-only) ================\n");
  const nowISO = new Date().toISOString(); // current instant for endDate filters (a true UTC now, not a promo string)

  // ── 0a. PATH + PARAM MATRIX: the endpoint runs forbidNonWhitelisted, so a rejected param
  //        answers 400 "property X should not exist" — that maps which params each path accepts.
  line("── 0a. PATH + PARAM WHITELIST (200 = accepted, 400 = 'property should not exist') ──");
  const PATHS = ["/admin/promocodes", "/api/v1/admin/promocodes"];
  const PARAMS: Array<[string, Record<string, string | number>]> = [
    ["limit", { limit: 1 }],
    ["page", { page: 1, limit: 1 }],
    ["code", { code: "MDTUESDAY", limit: 1 }],
    ["endDateMin", { endDateMin: nowISO, limit: 1 }],
    ["endDateMax", { endDateMax: nowISO, limit: 1 }],
    ["sortColumn+Direction", { sortColumn: "createdAt", sortDirection: "DESC", limit: 1 }],
    ["orderBy", { orderBy: "createdAt", limit: 1 }],
    ["isDeleted", { isDeleted: "true", limit: 1 }],
  ];
  const accepts: Record<string, Record<string, boolean>> = {};
  for (const p of PATHS) {
    accepts[p] = {};
    for (const [name, q] of PARAMS) {
      const r = await statusOf(p, q);
      accepts[p][name] = r.startsWith("200");
      line(`  ${p.padEnd(26)} ?${name.padEnd(20)} -> ${r}`);
    }
    line("");
  }
  // choose the list path: prefer /admin, but the search (code) + counts drive the real choice
  const adminOk = accepts["/admin/promocodes"];
  const v1Ok = accepts["/api/v1/admin/promocodes"];
  const searchPath = adminOk.code ? "/admin/promocodes" : v1Ok.code ? "/api/v1/admin/promocodes" : null;
  const listBase = adminOk.limit && adminOk.page ? "/admin/promocodes" : "/api/v1/admin/promocodes";
  line(`  => list/paging base: ${listBase}`);
  line(`  => code search accepted on: ${searchPath ?? "NEITHER (no server-side code search)"}`);
  line(`  => createdAt sort param accepted: admin[sortColumn]=${adminOk["sortColumn+Direction"]} orderBy=${adminOk.orderBy} | v1[sortColumn]=${v1Ok["sortColumn+Direction"]} orderBy=${v1Ok.orderBy}`);
  if (searchPath && searchPath !== listBase) line(`  ⚠ INCONSISTENCY: code search needs ${searchPath} but paging works on ${listBase} — DOCUMENT in docs/matchday-api-facts.md`);

  // ── 0b. ORDER STABILITY: page 1 twice, diff id sequence ──
  line("\n── 0b. ORDER STABILITY ──");
  const p1a = await get<ListResp>(listBase, { limit: 25, page: 1 });
  const p1b = await get<ListResp>(listBase, { limit: 25, page: 1 });
  const ids = (r: ListResp) => (r.data ?? []).map((x) => x.id);
  const idsA = ids(p1a), idsB = ids(p1b);
  const stable = JSON.stringify(idsA) === JSON.stringify(idsB);
  line(`  page1 fetch A ids: [${idsA.slice(0, 8).join(", ")}${idsA.length > 8 ? ", …" : ""}] (${idsA.length})`);
  line(`  page1 fetch B ids: [${idsB.slice(0, 8).join(", ")}${idsB.length > 8 ? ", …" : ""}] (${idsB.length})`);
  line(`  STABLE across two fetches: ${stable ? "YES" : "NO"}`);
  // order guess: compare id direction and createdAt direction across the first rows
  const rows = p1a.data ?? [];
  const idSeq = rows.map((r) => Number(r.id));
  const idDesc = idSeq.every((v, i) => i === 0 || v <= idSeq[i - 1]);
  const idAsc = idSeq.every((v, i) => i === 0 || v >= idSeq[i - 1]);
  const created = rows.map((r) => String(r.createdAt ?? ""));
  const createdDesc = created.every((v, i) => i === 0 || v <= created[i - 1]);
  const createdAsc = created.every((v, i) => i === 0 || v >= created[i - 1]);
  line(`  appears ordered by: id ${idDesc ? "DESC" : idAsc ? "ASC" : "(neither)"} | createdAt ${createdDesc ? "DESC" : createdAsc ? "ASC" : "(neither)"}`);
  line(`  totalItems (no date filter): ${p1a.totalItems ?? "absent"}`);
  if (!stable) { line("\n  ✗ ORDER NOT STABLE — STOP (0b failed): the reverse-page sort trick needs a stable total order."); process.exit(1); }

  // ── 0c. usageCount ON THE LIST ROW? print one raw row ──
  line("\n── 0c. usageCount ON THE LIST ROW ──");
  const row0 = (p1a.data ?? [])[0];
  if (!row0) { line("  (no rows returned — cannot inspect)"); }
  else {
    line("  raw list row[0] JSON:");
    line("  " + JSON.stringify(row0, null, 1).split("\n").join("\n  "));
    line(`  => usageCount present on list row: ${Object.prototype.hasOwnProperty.call(row0, "usageCount") ? `YES (= ${JSON.stringify(row0.usageCount)})` : "NO"}`);
    line(`  => numberOfUsesPerUser present: ${Object.prototype.hasOwnProperty.call(row0, "numberOfUsesPerUser") ? `YES (= ${JSON.stringify(row0.numberOfUsesPerUser)})` : "NO"}`);
    line(`  => list row keys: ${Object.keys(row0).join(", ")}`);
  }

  // ── 0d. code= SCOPE: with a code filter and NO date filter, does it span end dates + include soft-deleted? ──
  line("\n── 0d. code= SCOPE ──");
  const sampleCode = row0 ? String(row0.code) : null;
  if (!searchPath) { line("  code search not accepted on any path — the duplicate check has NO server endpoint. SKIP."); }
  else if (!sampleCode) { line("  (no sample code available)"); }
  else {
    line(`  (using search path: ${searchPath})`);
    const byCode = await get<ListResp>(searchPath, { code: sampleCode });
    const cr = byCode.data ?? [];
    const codes = [...new Set(cr.map((r) => String(r.code)))];
    const exactOnly = codes.length === 1 && codes[0] === sampleCode;
    const anyDeleted = cr.some((r) => r.deletedAt != null);
    const ends = cr.map((r) => String(r.endDateUtc ?? "")).filter(Boolean).sort();
    line(`  GET ${searchPath}?code=${sampleCode} (no endDateMin/Max)`);
    line(`  returned ${cr.length} row(s), totalItems=${byCode.totalItems ?? "absent"}; distinct codes: ${JSON.stringify(codes.slice(0, 6))}`);
    line(`  match semantics: ${exactOnly ? "EXACT (only the queried code)" : "SUBSTRING/broad (multiple codes)"}`);
    line(`  includes soft-deleted rows (deletedAt != null): ${anyDeleted ? "YES" : "none in this sample"}`);
    line(`  endDateUtc span in result: ${ends.length ? `${ends[0]} … ${ends[ends.length - 1]}` : "(none)"}`);
    // second probe: does an exact all-caps vs lowercase differ? (case sensitivity of code filter)
    if (sampleCode.toLowerCase() !== sampleCode || sampleCode.toUpperCase() !== sampleCode) {
      const flipped = sampleCode === sampleCode.toLowerCase() ? sampleCode.toUpperCase() : sampleCode.toLowerCase();
      const byFlip = await get<ListResp>(searchPath, { code: flipped });
      line(`  case check: ?code=${flipped} returned ${(byFlip.data ?? []).length} row(s) -> filter is ${(byFlip.data ?? []).length > 0 ? "case-INSENSITIVE" : "case-SENSITIVE"}`);
    } else {
      line(`  case check: sample code "${sampleCode}" has no letters to flip; skipped`);
    }
  }

  line("\n================ STEP 0 complete ================");
}

main().catch((e) => { console.error("PROBE ERROR:", e instanceof Error ? e.message : e); process.exit(2); });
