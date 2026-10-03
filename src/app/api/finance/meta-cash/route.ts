// GET /api/finance/meta-cash — the inputs OpEx needs to place Meta ad charges on their days
// (src/lib/metaCharges.ts): daily spend from fin_meta_ad_spend_daily, and the charges Meta's
// activity log recorded. READ-ONLY on both: no write to Supabase, GET only to Meta.
//
// FINANCE ONLY. authenticateCapability(req, "finance") checks can_access_finance and refuses a
// confined account. The Meta token never leaves the server; errors are redacted before they return.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { createClient } from "@supabase/supabase-js";
import { fetchMetaLoggedCharges } from "@/lib/metaAdSpendSync";
import { redactMetaError } from "@/lib/metaAdSpend";
import { selectAll } from "@/lib/supabasePagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How far back to read: enough to find the last bill-date charge (the 6th–9th) before today. */
const SINCE = "2026-07-01";

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "finance");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let rows: { spend_date: string; spend_cents: number; ad_account_id: string }[];
  try {
    rows = await selectAll(() => sb.from("fin_meta_ad_spend_daily").select("spend_date, spend_cents, ad_account_id").gte("spend_date", SINCE).order("spend_date"));
  } catch (e) {
    return Response.json({ error: `daily spend did not load: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.spend_date, (byDay.get(r.spend_date) ?? 0) + Number(r.spend_cents));
  const daily = [...byDay.entries()].map(([date, cents]) => ({ date, cents }));
  const account = rows.find((r) => r.ad_account_id)?.ad_account_id ?? null;

  if (!account) return Response.json({ error: "no Meta ad account in the daily spend table" }, { status: 500 });
  try {
    const logged = await fetchMetaLoggedCharges(account, SINCE);
    return Response.json({ daily, logged }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: `Meta's charge log did not load: ${redactMetaError(e instanceof Error ? e.message : String(e))}` }, { status: 502 });
  }
}
