// Staff app: ASK FOR A SIGN-IN CODE BY TEXT. Public: the caller is not signed in yet.
//
// It answers AT ONCE, with the same sentence for every number, and asks Supabase for the code only
// AFTER the response has gone (next/server after()). So neither the reply nor its timing can say
// whether a number belongs to staff (Ryan, 2026-10-29). Whether a text is actually sent is decided
// by the Send SMS hook (/api/auth/sms-hook), which only texts staff numbers.
//
// The only reply that differs is a malformed number, which says nothing about who is on staff.

import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { phoneLast4 } from "@/lib/changeLog";
import { PHONE_START_REPLY } from "@/lib/signInCode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { phone?: unknown } | null;
  const phone = normalizePhone(typeof body?.phone === "string" ? body.phone : null);
  if (!phone) return Response.json({ error: "Enter a mobile number, with its country code if it is not a US number." }, { status: 400 });

  after(async () => {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
      const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
      const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await anon.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
      // Logged for us, never returned: the reply has already gone, the same for every number.
      if (error) console.log(`[phone-start] ...${phoneLast4(phone)}: ${error.status ?? ""} ${error.message}`);
    } catch (e) {
      console.error(`[phone-start] ...${phoneLast4(phone)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return Response.json({ message: PHONE_START_REPLY });
}
