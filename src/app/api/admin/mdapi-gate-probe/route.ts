// GET /api/admin/mdapi-gate-probe?n=30 — ADMIN ONLY. Sends NOTHING to the MatchDay API.
//
// Measures, from inside a production function, what the MatchDay gate's global slot costs: n
// sequential take-and-give-back round trips on the slot table (0275), next to n plain Supabase reads
// for comparison. Ryan's bar (2026-11-18): if a slot adds more than ~20 ms to a staff screen, stop
// and use Upstash instead. The probe takes the "staff" lane while the gate is not yet live, so it
// competes with nobody; each slot is held for the time of one round trip.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { makeServerClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1), min: q(0) };
};

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const n = Math.min(50, Math.max(5, Number(new URL(req.url).searchParams.get("n") ?? 30) || 30));
  const sb = makeServerClient();
  const plain: number[] = [], acquire: number[] = [], release: number[] = [];
  // One warm-up of each, not counted: the first call on a new client pays connection setup.
  await sb.from("mdapi_gate_slots").select("slot").limit(1);
  for (let i = 0; i < n; i++) {
    let t = performance.now();
    const r = await sb.from("mdapi_gate_slots").select("slot").limit(1);
    if (r.error) return Response.json({ error: `plain read: ${r.error.message}` }, { status: 500 });
    plain.push(performance.now() - t);
    const holder = randomUUID();
    t = performance.now();
    const a = await sb.rpc("mdapi_gate_acquire", { p_env: "production", p_lane: "staff", p_holder: holder, p_label: "probe", p_lease_ms: 5000 });
    if (a.error) return Response.json({ error: `acquire: ${a.error.message}` }, { status: 500 });
    const slot = (a.data as { slot: number | null })?.slot;
    acquire.push(performance.now() - t);
    if (slot == null) return Response.json({ error: "no free staff slot (is the gate live already?)", acquired: a.data }, { status: 409 });
    t = performance.now();
    const rl = await sb.rpc("mdapi_gate_release", { p_lane: "staff", p_slot: slot, p_holder: holder });
    if (rl.error) return Response.json({ error: `release: ${rl.error.message}` }, { status: 500 });
    release.push(performance.now() - t);
  }
  return Response.json({
    region: process.env.VERCEL_REGION ?? null,
    plainRead: stats(plain), acquire: stats(acquire), release: stats(release),
    note: "ms per call, sequential, warm client. A staff request pays acquire on its path; release can run after the response.",
  });
}
