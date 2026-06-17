// Telnyx outbound-SMS ingest into telnyx_sms_log (see migration 0063).
//
// Telnyx only retains message bodies for ~10 days, so this table is the
// durable 90-day store. Two callers:
//   - the daily cron (/api/sync/cron) with a 2-day lookback window, and
//   - the on-demand "fetch recent" trigger (/api/sms-log/ingest) with a
//     short hours window.
// Both go through ingestTelnyxSms(); upsert-on-telnyx_message_id makes
// overlapping windows idempotent.
//
// Flow per run:
//   1. List messaging MDRs in the window via /v2/detail_records, keep
//      outbound message uuids.
//   2. GET /v2/messages/{uuid} for each (throttled batches) — the
//      authoritative per-message source for body, to/from, parts,
//      status, cost, errors.
//   3. Classify source_type: match_notify by id cross-reference against
//      match_notify_log.recipients[] first, then body patterns
//      (classifySmsBody), then 'other'.
//   4. Denormalize recipient first/last name + city from mdapi_users by
//      normalized phone (so the dashboard's city filter / name search
//      need no join).
//   5. Upsert on telnyx_message_id.
//   6. Prune rows older than 90 days by sent_at.
//
// Errors from a single body GET are swallowed (that message is skipped);
// a failure listing MDRs throws so the cron step is marked failed.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone, toNationalDigits } from "./phone";
import { classifySmsBody, type SmsSourceType } from "./telnyxSmsClassify";

const TELNYX_BASE = "https://api.telnyx.com/v2";
const MDR_PAGE_SIZE = 50; // Telnyx max
const MAX_MDR_PAGES = 40; // safety cap: up to 2000 MDRs per run
const BODY_BATCH = 8; // body GETs per throttled batch
const BODY_THROTTLE_MS = 150;
const RETENTION_DAYS = 90;

export type SmsIngestResult = {
  windowSince: string; // ISO start of the scanned window
  mdrsScanned: number;
  outboundSeen: number;
  bodiesFetched: number;
  rowsUpserted: number;
  rowsPruned: number;
  bySourceType: Record<SmsSourceType, number>;
};

type Mdr = {
  uuid?: string;
  id?: string;
  direction?: string;
  record_type?: string;
  message_type?: string;
  cld?: string; // destination (to)
  cli?: string; // origin (from)
  parts?: number;
  status?: string;
  carrier?: string;
  cost?: unknown; // string | { amount, currency } depending on record
  currency?: string;
  created_at?: string;
  sent_at?: string;
  completed_at?: string;
};

type TelnyxMessage = {
  id?: string;
  type?: string;
  text?: string;
  parts?: number;
  from?: { phone_number?: string; carrier?: string };
  to?: Array<{ phone_number?: string; status?: string; carrier?: string }>;
  cost?: { amount?: string | number; currency?: string } | null;
  direction?: string;
  sent_at?: string | null;
  completed_at?: string | null;
  received_at?: string | null;
  errors?: unknown[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emptySourceCounts(): Record<SmsSourceType, number> {
  return {
    match_notify: 0,
    player_match_reminder: 0,
    manager_match_reminder: 0,
    match_cancellation: 0,
    welcome_intro: 0,
    ops_broadcast: 0,
    booking_confirmation: 0,
    other: 0,
  };
}

// Telnyx cost shows up as either a string or a { amount, currency }
// object across MDR vs message-detail shapes. Pull a numeric amount
// defensively from whatever we got.
function costAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === "object" && "amount" in value) {
    return costAmount((value as { amount: unknown }).amount);
  }
  return null;
}

function costCurrency(value: unknown, fallback: string | null): string | null {
  if (value && typeof value === "object" && "currency" in value) {
    const c = (value as { currency?: unknown }).currency;
    if (typeof c === "string" && c) return c;
  }
  return fallback;
}

// Collect the set of telnyx_message_ids that belong to "Notify players"
// sends in the window, for the definitive match_notify cross-reference.
// Widen the lower bound by a day so a send that straddles the window
// edge is still attributed correctly.
async function loadMatchNotifyIds(
  supabase: SupabaseClient,
  sinceISO: string,
): Promise<Set<string>> {
  const widened = new Date(Date.parse(sinceISO) - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("match_notify_log")
    .select("recipients")
    .gte("sent_at", widened);
  if (error) {
    throw new Error(`telnyx-sms: match_notify_log read failed: ${error.message}`);
  }
  const ids = new Set<string>();
  for (const row of data ?? []) {
    const recipients = (row as { recipients?: unknown }).recipients;
    if (!Array.isArray(recipients)) continue;
    for (const r of recipients) {
      const id = (r as { telnyx_message_id?: unknown })?.telnyx_message_id;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return ids;
}

// Build a phone -> mdapi_users row map for the given E.164 recipient
// phones. mdapi_users.phone_number is a mix of E.164 and bare 10-digit
// national, so we query on both shapes and key the map by normalized
// E.164 for lookup.
type UserSnapshot = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  preferable_city_normalized: string | null;
};

async function loadRecipientSnapshots(
  supabase: SupabaseClient,
  phonesE164: string[],
): Promise<Map<string, UserSnapshot>> {
  const map = new Map<string, UserSnapshot>();
  if (phonesE164.length === 0) return map;

  // Both stored shapes: E.164 and national digits.
  const lookups = new Set<string>();
  for (const p of phonesE164) {
    lookups.add(p);
    const national = toNationalDigits(p);
    if (national) lookups.add(national);
  }

  const all = [...lookups];
  const CHUNK = 300; // keep the IN() list well under PostgREST URL limits
  for (let i = 0; i < all.length; i += CHUNK) {
    const slice = all.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("mdapi_users")
      .select("id, first_name, last_name, preferable_city_normalized, phone_number")
      .in("phone_number", slice);
    if (error) {
      throw new Error(`telnyx-sms: mdapi_users lookup failed: ${error.message}`);
    }
    for (const row of data ?? []) {
      const r = row as UserSnapshot & { phone_number: string | null };
      const key = normalizePhone(r.phone_number);
      // First match for a normalized phone wins; mdapi_users can hold
      // the same human under both shapes, the snapshot is identical.
      if (key && !map.has(key)) {
        map.set(key, {
          id: r.id,
          first_name: r.first_name,
          last_name: r.last_name,
          preferable_city_normalized: r.preferable_city_normalized,
        });
      }
    }
  }
  return map;
}

export async function ingestTelnyxSms(
  supabase: SupabaseClient,
  opts: { sinceISO: string },
): Promise<SmsIngestResult> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error("telnyx-sms: TELNYX_API_KEY not set");
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  const sinceISO = opts.sinceISO;
  // Telnyx detail_records created_at filter takes a date (YYYY-MM-DD).
  const sinceDate = sinceISO.slice(0, 10);

  // 1. List messaging MDRs, collect outbound message uuids.
  const uuids: string[] = [];
  let mdrsScanned = 0;
  let outboundSeen = 0;
  const mdrByUuid = new Map<string, Mdr>();
  for (let page = 1; page <= MAX_MDR_PAGES; page++) {
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
      throw new Error(
        `telnyx-sms: detail_records HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as { data?: Mdr[] };
    const rows = Array.isArray(json.data) ? json.data : [];
    mdrsScanned += rows.length;
    for (const r of rows) {
      if ((r.direction ?? "").toLowerCase() !== "outbound") continue;
      outboundSeen++;
      const id = r.uuid ?? r.id;
      if (id) {
        uuids.push(id);
        mdrByUuid.set(id, r);
      }
    }
    if (rows.length < MDR_PAGE_SIZE) break;
  }

  // Cross-reference set + per-message bodies in parallel-ish: load the
  // match_notify id set once up front.
  const matchNotifyIds = await loadMatchNotifyIds(supabase, sinceISO);

  // 2. Fetch message detail (throttled batches).
  type Fetched = { uuid: string; mdr: Mdr; msg: TelnyxMessage };
  const fetched: Fetched[] = [];
  for (let i = 0; i < uuids.length; i += BODY_BATCH) {
    const slice = uuids.slice(i, i + BODY_BATCH);
    const settled = await Promise.allSettled(
      slice.map(async (id): Promise<Fetched | null> => {
        const res = await fetch(
          `${TELNYX_BASE}/messages/${encodeURIComponent(id)}`,
          { headers },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: TelnyxMessage };
        const msg = json.data ?? {};
        return { uuid: id, mdr: mdrByUuid.get(id) ?? {}, msg };
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) fetched.push(s.value);
    }
    if (i + BODY_BATCH < uuids.length) await sleep(BODY_THROTTLE_MS);
  }

  // 3 + 4. Assemble rows: classify + denormalize recipient.
  type Row = {
    telnyx_message_id: string;
    direction: string;
    to_phone: string;
    from_phone: string | null;
    message_type: string | null;
    parts: number | null;
    delivery_status: string | null;
    message_body: string | null;
    source_type: SmsSourceType;
    cost_amount: number | null;
    cost_currency: string | null;
    carrier: string | null;
    errors: unknown[] | null;
    matched_user_id: number | null;
    recipient_first_name: string | null;
    recipient_last_name: string | null;
    recipient_city: string | null;
    sent_at: string | null;
    completed_at: string | null;
    telnyx_created_at: string | null;
    raw: unknown;
    ingested_at: string;
  };

  const draftRows: Array<Omit<Row, "matched_user_id" | "recipient_first_name" | "recipient_last_name" | "recipient_city"> & { toE164: string | null }> = [];
  for (const { uuid, mdr, msg } of fetched) {
    const toRaw = msg.to?.[0]?.phone_number ?? mdr.cld ?? null;
    if (!toRaw) continue; // to_phone is NOT NULL — nothing to anchor on
    const toE164 = normalizePhone(toRaw);
    const body = typeof msg.text === "string" ? msg.text : null;

    const source: SmsSourceType = matchNotifyIds.has(uuid)
      ? "match_notify"
      : classifySmsBody(body);

    const cost = msg.cost ?? mdr.cost ?? null;
    draftRows.push({
      telnyx_message_id: uuid,
      direction: "outbound",
      to_phone: toE164 ?? toRaw,
      from_phone: msg.from?.phone_number ?? mdr.cli ?? null,
      message_type: msg.type ?? mdr.message_type ?? null,
      parts: typeof msg.parts === "number" ? msg.parts : (mdr.parts ?? null),
      delivery_status: msg.to?.[0]?.status ?? mdr.status ?? null,
      message_body: body,
      source_type: source,
      cost_amount: costAmount(cost),
      cost_currency: costCurrency(cost, mdr.currency ?? null),
      carrier: msg.to?.[0]?.carrier ?? mdr.carrier ?? null,
      errors: Array.isArray(msg.errors) && msg.errors.length > 0 ? msg.errors : null,
      sent_at: msg.sent_at ?? mdr.sent_at ?? mdr.created_at ?? null,
      completed_at: msg.completed_at ?? mdr.completed_at ?? null,
      telnyx_created_at: mdr.created_at ?? msg.received_at ?? null,
      raw: { mdr, message: msg },
      ingested_at: new Date().toISOString(),
      toE164,
    });
  }

  // Recipient snapshots keyed by E.164.
  const phones = [
    ...new Set(
      draftRows
        .map((r) => r.toE164)
        .filter((p): p is string => typeof p === "string"),
    ),
  ];
  const snapshots = await loadRecipientSnapshots(supabase, phones);

  const rows: Row[] = draftRows.map((d) => {
    const snap = d.toE164 ? snapshots.get(d.toE164) : undefined;
    const { toE164: _drop, ...rest } = d;
    void _drop;
    return {
      ...rest,
      matched_user_id: snap?.id ?? null,
      recipient_first_name: snap?.first_name ?? null,
      recipient_last_name: snap?.last_name ?? null,
      recipient_city: snap?.preferable_city_normalized ?? null,
    };
  });

  // 5. Upsert on telnyx_message_id.
  const bySourceType = emptySourceCounts();
  let rowsUpserted = 0;
  const UPSERT_CHUNK = 500;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase
      .from("telnyx_sms_log")
      .upsert(chunk, { onConflict: "telnyx_message_id" });
    if (error) {
      throw new Error(`telnyx-sms: upsert failed: ${error.message}`);
    }
    rowsUpserted += chunk.length;
    for (const r of chunk) bySourceType[r.source_type]++;
  }

  // 6. Prune rows older than the retention window by sent_at.
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  let rowsPruned = 0;
  const { data: pruned, error: pruneErr } = await supabase
    .from("telnyx_sms_log")
    .delete()
    .lt("sent_at", cutoff)
    .select("id");
  if (pruneErr) {
    // Pruning is housekeeping; a failure should not fail the ingest.
    console.warn(`telnyx-sms: prune failed: ${pruneErr.message}`);
  } else {
    rowsPruned = pruned?.length ?? 0;
  }

  return {
    windowSince: sinceISO,
    mdrsScanned,
    outboundSeen,
    bodiesFetched: fetched.length,
    rowsUpserted,
    rowsPruned,
    bySourceType,
  };
}
