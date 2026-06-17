// TEMPORARY PROBE ROUTE - DELETE BEFORE THE /sms-log DASHBOARD SHIPS.
//
// One-time harvest of real outbound SMS bodies so we can write the
// source-type patterns against actual data. Admin-only. Output is
// phone-redacted and returns only the top 20 distinct body shapes from
// the last 7 days (no recipient phones, names, or ids).
//
// Flow: list messaging MDRs (last 7d) via /v2/detail_records to get
// outbound message uuids, then GET /v2/messages/{uuid} for the body
// (retrievable for 10 days), group by a digit-collapsed prefix, return
// the most common shapes.
//
// Trigger (from the browser console while logged into Cockpit as an
// admin):
//   const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.endsWith('-auth-token'));
//   const tok = JSON.parse(localStorage.getItem(k)).access_token;
//   const r = await fetch('/api/admin/telnyx-sample', { headers: { Authorization: 'Bearer ' + tok } });
//   console.log(JSON.stringify(await r.json(), null, 2));

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 60;

const TELNYX_BASE = "https://api.telnyx.com/v2";
const MDR_PAGES = 5; // up to 250 recent MDRs scanned
const MDR_PAGE_SIZE = 50; // Telnyx max
const MAX_BODY_FETCH = 200; // cap per-message body GETs
const BATCH = 8; // body GETs per throttled batch

type Mdr = {
  uuid?: string;
  id?: string;
  direction?: string;
  created_at?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Mask phone-like runs (7+ digits, optional + and separators) so the
// harvest carries no recipient numbers.
function redact(body: string): string {
  return body.replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted]");
}

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "TELNYX_API_KEY not set" }, { status: 500 });
  }
  const headers = { Authorization: `Bearer ${apiKey}` };

  const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // 1. List messaging MDRs, collect outbound uuids.
  const uuids: string[] = [];
  let totalOutbound = 0;
  try {
    for (let page = 1; page <= MDR_PAGES; page++) {
      const qs = new URLSearchParams();
      qs.set("filter[record_type]", "messaging");
      qs.set("filter[created_at][gte]", sinceDate);
      qs.set("page[number]", String(page));
      qs.set("page[size]", String(MDR_PAGE_SIZE));
      const res = await fetch(`${TELNYX_BASE}/detail_records?${qs.toString()}`, {
        headers,
      });
      if (!res.ok) {
        const text = await res.text();
        return Response.json(
          { error: `detail_records HTTP ${res.status}`, body: text.slice(0, 400) },
          { status: 502 },
        );
      }
      const json = (await res.json()) as { data?: Mdr[] };
      const rows = Array.isArray(json.data) ? json.data : [];
      for (const r of rows) {
        if ((r.direction ?? "").toLowerCase() !== "outbound") continue;
        totalOutbound++;
        const id = r.uuid ?? r.id;
        if (id && uuids.length < MAX_BODY_FETCH) uuids.push(id);
      }
      if (rows.length < MDR_PAGE_SIZE) break;
    }
  } catch (e) {
    return Response.json(
      { error: `detail_records fetch failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  // 2. Fetch bodies (throttled batches).
  const bodies: string[] = [];
  for (let i = 0; i < uuids.length; i += BATCH) {
    const slice = uuids.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      slice.map(async (id) => {
        const res = await fetch(`${TELNYX_BASE}/messages/${encodeURIComponent(id)}`, {
          headers,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: { text?: string } };
        return json.data?.text ?? null;
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value && s.value.trim()) {
        bodies.push(s.value.trim());
      }
    }
    if (i + BATCH < uuids.length) await sleep(150);
  }

  // 3. Group by digit-collapsed 80-char prefix; keep a representative.
  const groups = new Map<string, { count: number; sample: string }>();
  for (const b of bodies) {
    const key = b.toLowerCase().replace(/\d+/g, "#").slice(0, 80);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, sample: b });
  }
  const top = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((g) => ({ count: g.count, sample_body: redact(g.sample) }));

  return Response.json(
    {
      window_days: 7,
      total_outbound_seen: totalOutbound,
      bodies_fetched: bodies.length,
      distinct_types: top,
    },
    { status: 200 },
  );
}
