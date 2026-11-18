// /api/crm/auto-send/tick — every minute, cron only. Nothing a person can call. See aiDraftAutoRun.ts.
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runAutoSendTick } from "@/lib/aiDraftAutoRun";
import { withMdapiLane } from "@/lib/mdapiGate";

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
    // The bulk lane (mdapiGate.ts): the tick's player reads take the one global slot (one at a time
    // across Vercel, behind every sync). Its writes (credit, guest code) keep the write lane. The draft
    // context stays a live read: the mirror does not carry credits or strikes, so reading it would
    // change what a draft says.
    const out = await withMdapiLane("bulk", () => runAutoSendTick(sb));
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
