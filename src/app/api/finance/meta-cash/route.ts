// GET /api/finance/meta-cash — the inputs OpEx needs to place Meta ad charges on their days
// (src/lib/metaCharges.ts): the paid charges and Meta's latest unbilled balance, as the daily
// meta-ad-spend sync saved them (fin_meta_billing_charge, fin_meta_billing_balance; migration 0212).
//
// DATABASE ONLY. It used to read Meta's activity log on every page load — ~3 s a page, 16 pages,
// to find a few charges — which is why OpEx showed a different Meta view for its first ~10 s.
// READ-ONLY: no write, no call to Meta.
//
// FINANCE ONLY. authenticateCapability(req, "finance") checks can_access_finance and refuses a
// confined account.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { createClient } from "@supabase/supabase-js";
import { selectAll } from "@/lib/supabasePagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "finance");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let charges: { charged_at: string; amount_cents: number }[];
  try {
    charges = await selectAll(() => sb.from("fin_meta_billing_charge").select("charged_at, amount_cents, transaction_id").order("charged_at").order("transaction_id"));
  } catch (e) {
    return Response.json({ error: `Meta charges did not load: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  const bal = await sb.from("fin_meta_billing_balance").select("read_at, balance_cents").order("read_at", { ascending: false }).limit(1);
  if (bal.error) return Response.json({ error: `Meta's balance did not load: ${bal.error.message}` }, { status: 500 });
  const b = bal.data?.[0];
  if (!b) return Response.json({ error: "no Meta balance saved yet (the daily sync has not run since 0212)" }, { status: 500 });

  return Response.json({
    paid: charges.map((c) => ({ at: new Date(c.charged_at).toISOString(), cents: Number(c.amount_cents) })),
    balance: { at: new Date(b.read_at).toISOString(), cents: Number(b.balance_cents) },
  }, { headers: { "Cache-Control": "no-store" } });
}
