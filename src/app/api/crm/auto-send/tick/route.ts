// /api/crm/auto-send/tick — every minute, cron only. Nothing a person can call. See aiDraftAutoRun.ts.
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runAutoSendTick } from "@/lib/aiDraftAutoRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const same = (a: string, b: string) => { const ab = Buffer.from(a), bb = Buffer.from(b); return ab.length === bb.length && timingSafeEqual(ab, bb); };

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  if (!(token && cronSecret && same(token, cronSecret))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const out = await runAutoSendTick(sb);
    console.log(`[auto-send:tick] ${JSON.stringify(out).slice(0, 300)}`);
    return Response.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
    console.error("[auto-send:tick] failed", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;
