// GET /api/app/push/match-risk: the five-minute cron. Production only. Sends the match-at-risk push
// for any match that just entered its hour before auto-cancel below its minimum (once per match),
// then reads Expo receipts for earlier pushes and removes tokens Expo no longer recognises.
// CRON_SECRET only; nothing a person can call.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runMatchRisk } from "@/lib/appPushMatch";
import { sweepReceipts } from "@/lib/appPush";

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
  const out: Record<string, unknown> = {};
  try { out.matchRisk = await runMatchRisk(sb, "production"); } catch (e) { out.matchRisk = { error: e instanceof Error ? e.message : String(e) }; }
  try { out.receipts = await sweepReceipts(sb); } catch (e) { out.receipts = { error: e instanceof Error ? e.message : String(e) }; }
  console.log(`[app-push:cron] ${JSON.stringify(out).slice(0, 500)}`);
  return Response.json(out);
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;
