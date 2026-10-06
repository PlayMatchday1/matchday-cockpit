/* APP STORE CONNECT ANALYTICS REPORTS — the App Downloads files (Ryan, 2026-10-06). READ ONLY at
 * Apple: every call here is a GET with the everyday Sales-and-Reports key (lib/appStoreInstallsSync
 * mintToken). The two report requests were created 2026-10-05 with a short-lived Admin key:
 *
 *   ongoing    25012829-700a-4d29-9af5-a8a355f4b59b   a DAILY instance per processing day
 *   snapshot   bdc34702-e989-4c4f-a06e-f23edee877c8   the one-time history
 *
 * FILES (probe, 2026-10-06): tab-separated, gzipped, one or more segments per instance.
 *   Standard  Date | App Name | App Apple Identifier | Download Type | App Version | Device |
 *             Platform Version | Source Type | Page Type | Pre-Order | Territory | Counts
 *   Detailed  the same plus Source Info, Campaign and Page Title — and far fewer rows for the same
 *             days (23 against 181 for Oct 4–5): small rows are left out.
 * Columns are found BY NAME, never by position. Dates are plain calendar days ("2026-10-04"), taken
 * as-is. */

import { gunzipSync } from "node:zlib";

export const ASC_API = "https://api.appstoreconnect.apple.com";
export const ASC_REQUESTS = { ongoing: "25012829-700a-4d29-9af5-a8a355f4b59b", snapshot: "bdc34702-e989-4c4f-a06e-f23edee877c8" } as const;
export type AscRequestKind = keyof typeof ASC_REQUESTS;
export type AscReport = "standard" | "detailed";
const REPORT_NAMES: Record<string, AscReport> = { "App Downloads Standard": "standard", "App Downloads Detailed": "detailed" };

export type AscInstance = { id: string; request: AscRequestKind; report: AscReport; granularity: string; processingDate: string };
/* One stored row: the file's Counts summed over the columns the page uses. Page Type, device and
 * version are summed away. */
export type AscRow = {
  day: string; report: AscReport; download_type: string; source_type: string; source_info: string;
  campaign: string; territory: string; counts: number;
};

type Res = { id: string; attributes?: Record<string, unknown> };

async function getJson(token: string, path: string) {
  const res = await fetch(path.startsWith("http") ? path : `${ASC_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`App Store Connect ${res.status} on ${path.replace(ASC_API, "").split("?")[0]}: ${JSON.stringify(j.errors ?? j).slice(0, 200)}`);
  return j;
}
async function getAll(token: string, path: string): Promise<Res[]> {
  const out: Res[] = []; let next: string | null = path;
  while (next) {
    const j = await getJson(token, next);
    out.push(...((j.data as Res[]) ?? []));
    next = ((j.links as { next?: string } | undefined)?.next) ?? null;
  }
  return out;
}

/** Every instance Apple lists for the two download reports, on both requests. */
export async function listAscInstances(token: string): Promise<AscInstance[]> {
  const out: AscInstance[] = [];
  for (const [request, reqId] of Object.entries(ASC_REQUESTS) as [AscRequestKind, string][]) {
    const reports = await getAll(token, `/v1/analyticsReportRequests/${reqId}/reports?limit=200`);
    for (const rep of reports) {
      const report = REPORT_NAMES[String(rep.attributes?.name)];
      if (!report) continue;
      for (const i of await getAll(token, `/v1/analyticsReports/${rep.id}/instances?limit=200`)) {
        out.push({ id: i.id, request, report, granularity: String(i.attributes?.granularity ?? ""), processingDate: String(i.attributes?.processingDate ?? "") });
      }
    }
  }
  return out.sort((a, b) => a.processingDate.localeCompare(b.processingDate) || a.id.localeCompare(b.id));
}

/** Every segment of one instance, as header + rows. A header that differs between segments throws. */
export async function readAscInstance(token: string, instanceId: string): Promise<{ header: string[]; rows: string[][]; segments: number }> {
  const segs = await getAll(token, `/v1/analyticsReportInstances/${instanceId}/segments?limit=200`);
  let header: string[] | null = null; const rows: string[][] = [];
  for (const s of segs) {
    const url = s.attributes?.url as string | undefined;
    if (!url) throw new Error(`segment ${s.id} has no url`);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`segment ${s.id} download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let text: string; try { text = gunzipSync(buf).toString("utf8"); } catch { text = buf.toString("utf8"); }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const h = (lines[0] ?? "").split("\t").map((x) => x.trim());
    if (header && header.join("\t") !== h.join("\t")) throw new Error(`segment ${s.id} header differs from the first segment's`);
    header = h;
    for (const l of lines.slice(1)) rows.push(l.split("\t"));
  }
  return { header: header ?? [], rows, segments: segs.length };
}

/** Sum a file's Counts over (day, download type, source type, source info, campaign, territory). */
export function aggregateAsc(report: AscReport, header: string[], rows: string[][]): AscRow[] {
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iDate = col("Date"), iType = col("Download Type"), iSrc = col("Source Type"), iInfo = col("Source Info"),
    iCamp = col("Campaign"), iTerr = col("Territory"), iCount = col("Counts");
  const missing = [["Date", iDate], ["Download Type", iType], ["Source Type", iSrc], ["Territory", iTerr], ["Counts", iCount]].filter(([, i]) => i === -1).map(([n]) => n);
  if (missing.length) throw new Error(`App Downloads ${report}: missing column(s) ${missing.join(", ")}`);
  const by = new Map<string, AscRow>();
  for (const r of rows) {
    const day = (r[iDate] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`App Downloads ${report}: unreadable date "${day}"`);
    const n = Number((r[iCount] ?? "").trim());
    if (!Number.isFinite(n) || n < 0) throw new Error(`App Downloads ${report}: unreadable count "${r[iCount]}"`);
    const row: AscRow = {
      day, report, download_type: (r[iType] ?? "").trim(), source_type: (r[iSrc] ?? "").trim(),
      source_info: iInfo >= 0 ? (r[iInfo] ?? "").trim() : "", campaign: iCamp >= 0 ? (r[iCamp] ?? "").trim() : "",
      territory: (r[iTerr] ?? "").trim(), counts: 0,
    };
    const k = [row.day, row.download_type, row.source_type, row.source_info, row.campaign, row.territory].join("\u0001");
    const e = by.get(k) ?? (by.set(k, row), row);
    e.counts += n;
  }
  return [...by.values()];
}

/* ── THE SYNC (source 'asc-analytics', run after the Google steps in /api/sync/acquisition-google) ──
 * Every App Downloads instance Apple lists that is not yet in acq_asc_instance is read and stored,
 * oldest processing date first. A file REPLACES the days it covers for its report: the audit
 * (2026-10-06) found the daily file restating Oct 4 and Oct 5 exactly as the history file had them
 * (157 / 251 and 134 / 193), so a later file is the newer statement of a whole day, never an
 * increment. The instance row is written LAST, so a run that dies midway re-reads that file next
 * time. Days before `floor` (Jul 1, 2026, the page's floor) are not stored.
 *
 * The one-time Detailed history does not exist yet; when Apple delivers it, it is a new instance
 * like any other and the next run stores it from Jul 1 — nothing to switch on. */
type Sb = import("@supabase/supabase-js").SupabaseClient;
export async function syncAscDownloads(sb: Sb, token: string, floor: string): Promise<{ instances: number; stored: number; rows: number; files: string[] }> {
  const all = await listAscInstances(token);
  const { data: done, error } = await sb.from("acq_asc_instance").select("instance_id");
  if (error) throw new Error(`acq_asc_instance: ${error.message}`);
  const seen = new Set((done ?? []).map((d) => d.instance_id as string));
  let stored = 0, rowsOut = 0; const files: string[] = [];
  for (const inst of all) {
    if (seen.has(inst.id)) continue;
    const f = await readAscInstance(token, inst.id);
    const rows = aggregateAsc(inst.report, f.header, f.rows).filter((r) => r.day >= floor);
    const days = [...new Set(rows.map((r) => r.day))].sort();
    for (let i = 0; i < days.length; i += 100) {
      const { error: de } = await sb.from("acq_asc_downloads_daily").delete().eq("report", inst.report).in("day", days.slice(i, i + 100));
      if (de) throw new Error(`clearing ${inst.report} days: ${de.message}`);
    }
    for (let i = 0; i < rows.length; i += 1000) {
      const { error: ie } = await sb.from("acq_asc_downloads_daily").insert(rows.slice(i, i + 1000));
      if (ie) throw new Error(`storing ${inst.report} ${inst.processingDate}: ${ie.message}`);
    }
    const { error: le } = await sb.from("acq_asc_instance").insert({
      instance_id: inst.id, request: inst.request, report: inst.report, granularity: inst.granularity, processing_date: inst.processingDate,
      first_day: days[0] ?? null, last_day: days[days.length - 1] ?? null, file_rows: f.rows.length, stored_rows: rows.length,
    });
    if (le) throw new Error(`acq_asc_instance: ${le.message}`);
    stored += 1; rowsOut += rows.length;
    files.push(`${inst.request} ${inst.report} ${inst.processingDate}: ${rows.length} rows, ${days[0] ?? "-"}..${days[days.length - 1] ?? "-"}`);
  }
  return { instances: all.length, stored, rows: rowsOut, files };
}
