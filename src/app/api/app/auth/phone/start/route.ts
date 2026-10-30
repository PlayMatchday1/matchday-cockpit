// Staff app: ASK FOR A SIGN-IN CODE BY TEXT. Public: the caller is not signed in yet.
//
// It asks Supabase to start phone sign-in for the number, with shouldCreateUser false, and then
// answers the SAME sentence after the SAME minimum time whatever happened: staff number, unknown
// number, rate limited, or Supabase down. Whether a number belongs to staff is never revealed here.
// The decision to send is made by the Send SMS hook (/api/auth/sms-hook), not by this route.
//
// The only thing that differs is a malformed number, which is refused up front because that says
// nothing about who is on staff.

import { createClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { phoneLast4 } from "@/lib/changeLog";
import { PHONE_START_MIN_MS, PHONE_START_REPLY } from "@/lib/signInCode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const started = Date.now();
  const body = (await req.json().catch(() => null)) as { phone?: unknown } | null;
  const phone = normalizePhone(typeof body?.phone === "string" ? body.phone : null);
  if (!phone) return Response.json({ error: "Enter a mobile number, with its country code if it is not a US number." }, { status: 400 });

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
    const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await anon.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
    // Logged for us, never returned: the reply is the same either way.
    if (error) console.log(`[phone-start] ...${phoneLast4(phone)}: ${error.status ?? ""} ${error.message}`);
  } catch (e) {
    console.error(`[phone-start] ...${phoneLast4(phone)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const wait = PHONE_START_MIN_MS - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return Response.json({ message: PHONE_START_REPLY });
}
