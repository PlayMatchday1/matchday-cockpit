import "server-only";
// WordPress form submissions → web_submissions / web_contacts. Server-only.
//
// READ-ONLY AGAINST THE SITE. Every request is a GET; there is no POST or DELETE path to that host
// anywhere in this integration, and the host guard below refuses any URL whose PARSED host is not
// the one configured — `…playmatchday.com.evil.com` parses to that whole string and is rejected,
// where a startsWith() check would wave it through.
//
// THE KEY TRAVELS IN AN X-MD-Key HEADER, never a query parameter, so it cannot survive into a
// logged URL. Nothing here echoes, logs or interpolates it, including into error messages — see
// redactWp, which exists because the obvious `throw new Error(url)` is how a secret escapes.
//
// ── WHAT WILL ACTUALLY BREAK THIS ─────────────────────────────────────────────────────────────
// Editing an Elementor form can MINT A NEW FORM ID. That is how five Team Application forms and
// four dead ones came to exist. When it happens, new submissions arrive under an element_id this
// code has never seen and resolve to nothing — and they will keep arriving, silently, looking like
// a quiet week rather than a broken pipe.
//
// So an unseen element_id is FLAGGED, never guessed at, and the count is surfaced ON THE PAGE as
// well as in the sync log. Someone has to be able to see it without opening a log.

import {
  PINNED_FORMS, toSubmissionRow, streamFor, resolveCity,
  type FormLabels, type RawSubmission, type SubmissionRowOut,
} from "./webSubmissions";
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = 500;

export type WpSyncResult = {
  fetched: number;
  newSubmissions: number;
  updatedSubmissions: number;
  newContacts: number;
  contactsUntouched: number;
  spamFlagged: number;
  unresolvedByElement: Record<string, number>;
  labelsRefreshed: number;
  unmappedCities: Record<string, number>;
  ownRowsSkipped: number;
  /** ?probe=1's count, and ours. REPORTED, NEVER ACTED ON — a shortfall means someone deleted a
   *  submission in WordPress, and our mirror is supposed to outlive that. */
  sourceCount: number | null;
  heldCount: number;
  drift: number | null;
  apiCalls: number;
};

/** Strip anything secret-shaped before an error leaves this module. */
export function redactWp(msg: string): string {
  return msg
    .replace(/X-MD-Key:\s*\S+/gi, "X-MD-Key: [REDACTED]")
    .replace(/([?&])key=[^&\s"']+/gi, "$1key=[REDACTED]");
}

/* THE HOST GUARD, ON THE PARSED HOST. The allowlist is the configured URL's own host — every
 * request this module makes must resolve to exactly that, so a path or parameter cannot redirect
 * it elsewhere. */
function baseUrl(): URL {
  const raw = process.env.WP_SUBMISSIONS_URL?.trim();
  if (!raw) throw new Error("WP_SUBMISSIONS_URL is not set");
  try { return new URL(raw); } catch { throw new Error("WP_SUBMISSIONS_URL is not a valid URL"); }
}
function assertSameHost(u: URL, base: URL): void {
  if (u.host.toLowerCase() !== base.host.toLowerCase()) {
    // The HOST may appear — it is not the secret, and naming it is the whole point of the refusal.
    throw new Error(`Refusing request to disallowed host: ${u.host}`);
  }
  if (u.protocol !== "https:") throw new Error(`Refusing non-https request to ${u.host}`);
}

let apiCalls = 0;

/** GET only. ONE retry on 5xx, never more. Redirects are refused rather than followed — a 301 to
 *  another host would hand it our key. */
async function wpGet(params: Record<string, string>): Promise<Record<string, unknown>> {
  const key = process.env.WP_SUBMISSIONS_KEY?.trim();
  if (!key) throw new Error("WP_SUBMISSIONS_KEY is not set");
  const base = baseUrl();
  const u = new URL(base.toString());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (u.searchParams.has("key") || u.searchParams.has("access_token")) {
    throw new Error("refusing: the key must travel in the X-MD-Key header");
  }
  assertSameHost(u, base);

  for (let attempt = 0; attempt < 2; attempt++) {
    apiCalls++;
    const r = await fetch(u, {
      method: "GET",
      headers: { "X-MD-Key": key, accept: "application/json" },
      redirect: "manual",          // a redirect must not carry the key to a new host
      cache: "no-store",
    });
    if (r.status >= 300 && r.status < 400) {
      throw new Error(`Refusing to follow a redirect from ${u.host} (status ${r.status})`);
    }
    if (r.ok) {
      const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) throw new Error(`${u.host} returned a non-JSON body`);
      return body;
    }
    if (r.status >= 500 && attempt === 0) continue;   // ONE retry, reads only
    const text = await r.text().catch(() => "");
    throw new Error(redactWp(`wp ${r.status}: ${text.slice(0, 200)}`));
  }
  throw new Error("wp: unreachable");
}

/** ?forms=1 → element_id -> labels. Fetched ONCE per run and cached for it. */
export async function fetchFormRegistry(): Promise<Record<string, FormLabels>> {
  const body = await wpGet({ forms: "1" });
  const out: Record<string, FormLabels> = {};
  const forms = (body.forms ?? body.data ?? []) as Array<Record<string, unknown>>;
  for (const f of Array.isArray(forms) ? forms : []) {
    const el = String(f.element_id ?? f.id ?? "");
    if (!el) continue;
    const labels: Record<string, string> = {};
    const fields = (f.fields ?? {}) as Record<string, unknown>;
    for (const [fid, label] of Object.entries(fields)) labels[fid] = String(label);
    out[el] = { elementId: el, formName: String(f.form_name ?? f.name ?? ""), labels, source: "forms-api" };
  }
  /* THE PINNED PAIR WINS. Those two are the fixture whose collision the suite asserts, and a
   * remote edit must not quietly redefine them under this code's feet. Everything the site knows
   * that we do not is merged in beneath. */
  return { ...out, ...PINNED_FORMS };
}

export async function syncWpSubmissions(sb: SupabaseClient): Promise<WpSyncResult> {
  apiCalls = 0;

  // The CSV import also stored labels for the four forms the site can no longer resolve. Both
  // sources merge, keyed on element_id, so a historical row keeps resolving after the sync runs.
  const stored: Record<string, FormLabels> = {};
  const { data: lrows } = await sb.from("web_form_labels").select("element_id,field_id,label,form_name,source");
  for (const r of lrows ?? []) {
    const el = String(r.element_id);
    const cur = stored[el] ?? { elementId: el, formName: String(r.form_name ?? ""), labels: {} as Record<string, string>, source: "csv" as const };
    (cur.labels as Record<string, string>)[String(r.field_id)] = String(r.label);
    stored[el] = cur;
  }
  const live = await fetchFormRegistry();
  const registry: Record<string, FormLabels> = { ...stored, ...live };

  /* PERSIST WHAT THE SITE STILL KNOWS. Without this the page keeps reading the CSV snapshot
   * forever: a label edited on a live form would render under its old name indefinitely, and the
   * only record that the site had moved on would be inside this function's memory for one run.
   *
   * source='forms-api' overwrites the CSV row for the two forms that still resolve, and leaves the
   * four that do not — those CSV rows are the ONLY record of their labels and must not be
   * clobbered by a form the site no longer returns. */
  const liveLabels = Object.values(live)
    .filter((f) => f.source === "forms-api")
    .flatMap((f) => Object.entries(f.labels).map(([field_id, label]) => ({
      element_id: f.elementId, field_id, label, form_name: f.formName, source: "forms-api" as const,
    })));
  if (liveLabels.length) {
    const { error } = await sb.from("web_form_labels").upsert(liveLabels, { onConflict: "element_id,field_id" });
    if (error) throw new Error(`web_form_labels upsert failed: ${error.message}`);
  }

  // START FROM WHAT WE HOLD, never from zero — a full re-walk every night is 664 rows of nothing.
  const { data: maxRow } = await sb.from("web_submissions").select("submission_id").order("submission_id", { ascending: false }).limit(1);
  let after = Number(maxRow?.[0]?.submission_id ?? 0);

  const rows: SubmissionRowOut[] = [];
  let fetched = 0, ownSkipped = 0, guard = 0;
  for (;;) {
    if (guard++ > 200) throw new Error("wp: paging guard tripped");
    const body = await wpGet({ after_id: String(after), limit: String(PAGE) });
    const batch = (body.submissions ?? body.data ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(batch) || batch.length === 0) break;
    fetched += batch.length;
    for (const s of batch) {
      const raw: RawSubmission = {
        submissionId: Number(s.id),
        elementId: String(s.element_id ?? ""),
        formName: (s.form_name as string) ?? null,
        referer: (s.referer as string) ?? null,
        createdAt: (s.created_at_gmt as string) ?? (s.created_at as string) ?? null,
        fields: (s.fields ?? {}) as Record<string, unknown>,
      };
      // THE SAME BUILDER THE CSV IMPORT USES. Not a second implementation of the same decisions.
      const row = toSubmissionRow(raw, registry, "sync");
      if (row === null) { ownSkipped++; continue; }   // one of our own test addresses
      rows.push(row);
    }
    const next = body.next_after_id;
    if (next === null || next === undefined) break;
    after = Number(next);
  }

  // ── WRITE 1: submissions. Upsert on the id, so a revised row overwrites and a re-run is free.
  const existing = new Set<number>();
  if (rows.length) {
    const ids = rows.map((r) => r.submission_id);
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await sb.from("web_submissions").select("submission_id").in("submission_id", ids.slice(i, i + 500));
      for (const r of data ?? []) existing.add(Number(r.submission_id));
    }
    for (let i = 0; i < rows.length; i += 300) {
      const { error } = await sb.from("web_submissions").upsert(rows.slice(i, i + 300), { onConflict: "submission_id" });
      if (error) throw new Error(`web_submissions upsert failed: ${error.message}`);
    }
  }

  /* ── WRITE 2: contacts. INSERT MISSING ONLY.
   * ignoreDuplicates means an existing row is left EXACTLY as it is — status, owner and notes all
   * untouched. Outreach attaches to the person, and a nightly sync that reset someone's status
   * because they applied again would destroy the only signal the page carries. */
  const wanted = [...new Map(rows.filter((r) => r.email && !r.is_spam)
    .map((r) => [`${r.stream}|${r.email}`, { stream: r.stream, email: r.email! }])).values()];
  let newContacts = 0, untouched = 0;
  if (wanted.length) {
    const { data: have } = await sb.from("web_contacts").select("stream,email")
      .in("email", wanted.map((w) => w.email));
    const haveSet = new Set((have ?? []).map((h) => `${h.stream}|${h.email}`));
    untouched = wanted.filter((w) => haveSet.has(`${w.stream}|${w.email}`)).length;
    newContacts = wanted.length - untouched;
    const { error } = await sb.from("web_contacts").upsert(wanted, { onConflict: "stream,email", ignoreDuplicates: true });
    if (error) throw new Error(`web_contacts insert failed: ${error.message}`);
  }

  // ── DRIFT: reported, never acted on.
  let sourceCount: number | null = null;
  try {
    const probe = await wpGet({ probe: "1" });
    const n = Number(probe.submission_count ?? probe.count ?? probe.total);
    sourceCount = Number.isFinite(n) ? n : null;
  } catch { sourceCount = null; }   // a probe failure must not fail a completed sync
  const { count: held } = await sb.from("web_submissions").select("submission_id", { count: "exact", head: true });

  const unresolvedByElement: Record<string, number> = {};
  for (const r of rows) if (r.unresolved) unresolvedByElement[r.element_id] = (unresolvedByElement[r.element_id] ?? 0) + 1;
  const unmappedCities: Record<string, number> = {};
  for (const r of rows) if (!r.city_code && r.city_raw) unmappedCities[r.city_raw] = (unmappedCities[r.city_raw] ?? 0) + 1;

  return {
    fetched,
    newSubmissions: rows.filter((r) => !existing.has(r.submission_id)).length,
    updatedSubmissions: rows.filter((r) => existing.has(r.submission_id)).length,
    newContacts, contactsUntouched: untouched,
    spamFlagged: rows.filter((r) => r.is_spam).length,
    unresolvedByElement, unmappedCities, ownRowsSkipped: ownSkipped,
    labelsRefreshed: liveLabels.length,
    sourceCount, heldCount: held ?? 0,
    drift: sourceCount == null ? null : sourceCount - (held ?? 0),
    apiCalls,
  };
}

export { streamFor, resolveCity };
