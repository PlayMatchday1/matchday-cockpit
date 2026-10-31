// SUPABASE SEND SMS HOOK: the only path a staff sign-in code takes to a phone.
//
// Supabase Auth calls this, signed, every time it wants to text a one-time code (a phone
// signInWithOtp). It is THE GATE (Ryan, 2026-10-29): it sends only when the number is on an
// app_users row, at most 5 codes per number per hour, and never within 30 seconds of the last
// request. Every request is recorded in app_sms_code_requests, sent or not. Calling Supabase phone
// sign-in directly, without the app, cannot get past this: Supabase has no other way to send.
//
// The text goes out through Telnyx from TELNYX_FROM_NUMBER (10DLC campaign C3O7LXE, use case
// Mixed). Its body is signInCodeText, which the Telnyx ingest recognises and never stores.
//
// The code itself is never logged, returned, or written anywhere but the text message.

import Telnyx from "telnyx";
import { makeServerClient } from "@/lib/supabaseServer";
import { normalizePhone } from "@/lib/phone";
import { phoneLast4 } from "@/lib/changeLog";
import { verifyStandardWebhook } from "@/lib/standardWebhook";
import { isFictionalTestNumber, signInCodeText, smsGate } from "@/lib/signInCode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const refuse = (http_code: number, message: string) => Response.json({ error: { http_code, message } }, { status: http_code });

export async function POST(req: Request) {
  const secret = process.env.SEND_SMS_HOOK_SECRET?.trim() ?? "";
  const raw = await req.text();
  const ok = verifyStandardWebhook(secret, {
    id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature"),
  }, raw, Math.floor(Date.now() / 1000));
  if (!ok) return refuse(401, "Signature did not verify.");

  let payload: { user?: { phone?: string }; sms?: { otp?: string } };
  try { payload = JSON.parse(raw); } catch { return refuse(400, "Body is not JSON."); }
  const phone = normalizePhone(payload.user?.phone ? `+${String(payload.user.phone).replace(/^\+/, "")}` : null);
  const otp = payload.sms?.otp ?? "";
  const fictional = isFictionalTestNumber(phone);
  if (!phone || (!fictional && !/^\d{6}$/.test(otp))) return refuse(400, "Phone or code missing.");

  const sb = makeServerClient();
  const staff = await sb.from("app_users").select("id, is_service_account").eq("phone", phone).limit(2);
  if (staff.error) {
    console.error(`[sms-hook] app_users lookup failed for ...${phoneLast4(phone)}: ${staff.error.message}`);
    return refuse(503, "Staff lookup failed.");
  }
  const rows = (staff.data ?? []).filter((r) => r.is_service_account !== true);
  const now = new Date();
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  const recent = await sb.from("app_sms_code_requests").select("requested_at").eq("phone", phone).gte("requested_at", since);
  if (recent.error) {
    console.error(`[sms-hook] request log read failed: ${recent.error.message}`);
    return refuse(503, "Request log unavailable.");
  }
  // Recorded BEFORE deciding, so a refused request still counts towards the limits.
  const rec = await sb.from("app_sms_code_requests").insert({ phone, requested_at: now.toISOString() });
  if (rec.error) {
    console.error(`[sms-hook] request log write failed: ${rec.error.message}`);
    return refuse(503, "Request log unavailable.");
  }
  const gate = smsGate(rows.length === 1, (recent.data ?? []).map((r) => new Date(r.requested_at as string)), now);
  if (!gate.send) {
    console.warn(`[sms-hook] refused ...${phoneLast4(phone)}: ${gate.reason}${rows.length > 1 ? " (number on more than one staff account)" : ""}`);
    return refuse(gate.httpCode, gate.message);
  }

  // A fictional test number on a staff row: Supabase's fixed code signs it in; nothing is texted.
  if (fictional) {
    console.log(`[sms-hook] test number ...${phoneLast4(phone)}: allowed, nothing sent`);
    return Response.json({}, { status: 200 });
  }

  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const from = process.env.TELNYX_FROM_NUMBER?.trim();
  if (!apiKey || !from) return refuse(500, "Telnyx is not configured.");
  try {
    const sent = await new Telnyx({ apiKey }).messages.send({ from, to: phone, text: signInCodeText(otp) });
    console.log(`[sms-hook] sent to ...${phoneLast4(phone)} message ${sent.data?.id ?? "?"}`);
    // Supabase Auth refuses a bodyless 200 ("Missing Content-Type header") after the text has
    // already gone, so the sign-in fails; an empty JSON object is what it accepts.
    return Response.json({}, { status: 200 });
  } catch (e) {
    console.error(`[sms-hook] Telnyx send failed to ...${phoneLast4(phone)}: ${e instanceof Error ? e.message : String(e)}`);
    return refuse(502, "The text could not be sent.");
  }
}
