// TEMPORARY read-only WABA diagnostic. Diagnosis only — NO sending,
// NO POST /messages, NO send-path code touched. Deleted in the same
// session it was created.
//
// GET /api/admin/whatsapp/waba-diag?key=...
//
// Purpose: the /chats template send 404s with #132001 "support_followup
// does not exist in en" even though the template is Active in Business
// Manager. The send authenticates against the WABA that owns phone
// number META_PHONE_NUMBER_ID (1057015700836671), NOT META_WABA_ID.
// This route uses the SAME stored META_ACCESS_TOKEN as the send path
// so WABA visibility matches production exactly, and reports:
//   1. Which WABA owns the sending phone number.
//   2. Whether support_followup exists under THAT WABA + its language.
//   3. All WABAs the token can see, and which one contains the template.
//   4. Whether support_followup exists under META_WABA_ID (expected no).
//
// Auth: ephemeral hardcoded key below (constant-time compared). Not a
// Vercel env var — no new secret provisioned; the whole file is deleted
// within this session. The token is read from env, never returned or
// logged.

import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 30;

const GRAPH_VERSION = "v21.0";
const SENDING_PHONE_NUMBER_ID = "1057015700836671"; // META_PHONE_NUMBER_ID
const META_WABA_ID = "3100706866793096"; // META_WABA_ID env value

// Ephemeral gate. Deleted with this file this session.
const GATE_KEY = "1210f412e75f8bd1b0f38e0d0ca24f4f5ac25959";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Recursively drop any key literally named access_token / input_token
// so a Graph response can never carry a token back to the caller.
function stripTokens(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripTokens);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "access_token" || k === "input_token") continue;
      out[k] = stripTokens(val);
    }
    return out;
  }
  return v;
}

async function graphGet(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [k, val] of Object.entries(params)) url.searchParams.set(k, val);
  // Token goes in the header, never the URL, so it can't land in any
  // Graph-side access log tied to the query string.
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  let body: unknown;
  try {
    body = stripTokens(await res.json());
  } catch {
    body = { error: "non-JSON response" };
  }
  return { status: res.status, body };
}

function templatesFor(name: string) {
  return {
    fields: "name,language,status,category",
    name,
  };
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (!constantTimeMatch(params.get("key") ?? "", GATE_KEY)) {
    return Response.json({ error: "Invalid or missing key" }, { status: 401 });
  }

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return Response.json(
      { error: "META_ACCESS_TOKEN not configured" },
      { status: 500 },
    );
  }

  // Step 0: inspect the token itself. granular_scopes[].target_ids
  // lists the WABA IDs this token is authorized against — the exact
  // set the production send path can see.
  const debug = await graphGet(
    "debug_token",
    { input_token: token },
    token,
  );
  const debugData = (debug.body as { data?: Record<string, unknown> })?.data ?? {};
  const granular = Array.isArray(debugData.granular_scopes)
    ? (debugData.granular_scopes as Array<{ scope?: string; target_ids?: string[] }>)
    : [];
  const scopeWabaIds = new Set<string>();
  for (const g of granular) {
    for (const id of g.target_ids ?? []) scopeWabaIds.add(id);
  }

  // Candidate WABAs = everything the token is scoped to, plus the
  // configured META_WABA_ID (may or may not overlap).
  const candidateWabas = Array.from(
    new Set<string>([...scopeWabaIds, META_WABA_ID]),
  );

  // Sending phone number node info (which WABA it belongs to is derived
  // below by matching it inside each WABA's phone_numbers list).
  const sendingPhone = await graphGet(
    SENDING_PHONE_NUMBER_ID,
    { fields: "id,display_phone_number,verified_name,name_status,quality_rating" },
    token,
  );

  // Per-WABA: list phone numbers (to locate the sending phone) and
  // check for support_followup.
  const perWaba: Array<{
    waba_id: string;
    phone_numbers_status: number;
    phone_numbers: unknown;
    contains_sending_phone: boolean;
    template_status: number;
    template_matches: Array<{ language?: string; status?: string; category?: string }>;
    template_raw: unknown;
  }> = [];

  for (const waba of candidateWabas) {
    const phones = await graphGet(
      `${waba}/phone_numbers`,
      { fields: "id,display_phone_number,verified_name" },
      token,
    );
    const phoneList = Array.isArray((phones.body as { data?: unknown[] })?.data)
      ? ((phones.body as { data: Array<{ id?: string }> }).data)
      : [];
    const containsSendingPhone = phoneList.some(
      (p) => p.id === SENDING_PHONE_NUMBER_ID,
    );

    const tpl = await graphGet(
      `${waba}/message_templates`,
      templatesFor("support_followup"),
      token,
    );
    const tplData = Array.isArray((tpl.body as { data?: unknown[] })?.data)
      ? ((tpl.body as { data: Array<{ language?: string; status?: string; category?: string }> }).data)
      : [];

    perWaba.push({
      waba_id: waba,
      phone_numbers_status: phones.status,
      phone_numbers: phones.body,
      contains_sending_phone: containsSendingPhone,
      template_status: tpl.status,
      template_matches: tplData.map((t) => ({
        language: t.language,
        status: t.status,
        category: t.category,
      })),
      template_raw: tpl.body,
    });
  }

  const sendingPhoneWaba = perWaba.find((w) => w.contains_sending_phone) ?? null;
  const templateWabas = perWaba.filter((w) => w.template_matches.length > 0);
  const metaWabaEntry = perWaba.find((w) => w.waba_id === META_WABA_ID) ?? null;

  return Response.json({
    ok: true,
    sending_phone_number_id: SENDING_PHONE_NUMBER_ID,
    meta_waba_id: META_WABA_ID,
    sending_phone_node: { status: sendingPhone.status, body: sendingPhone.body },
    token_scope_waba_ids: Array.from(scopeWabaIds),
    candidate_wabas: candidateWabas,

    answers: {
      // (1) WABA that owns the sending phone number.
      q1_sending_phone_waba_id: sendingPhoneWaba?.waba_id ?? null,
      // (2) support_followup under THAT WABA + language.
      q2_template_in_sending_phone_waba: sendingPhoneWaba
        ? {
            exists: sendingPhoneWaba.template_matches.length > 0,
            languages: sendingPhoneWaba.template_matches.map((t) => t.language),
            matches: sendingPhoneWaba.template_matches,
          }
        : { note: "sending phone not found in any visible WABA" },
      // (3) which WABA(s) actually contain support_followup.
      q3_wabas_containing_template: templateWabas.map((w) => ({
        waba_id: w.waba_id,
        languages: w.template_matches.map((t) => t.language),
        matches: w.template_matches,
      })),
      // (4) support_followup under META_WABA_ID (expected: none).
      q4_template_in_meta_waba: metaWabaEntry
        ? {
            exists: metaWabaEntry.template_matches.length > 0,
            matches: metaWabaEntry.template_matches,
          }
        : { note: "META_WABA_ID not queried" },
    },

    debug_token: debug.body,
    per_waba: perWaba,
  });
}
