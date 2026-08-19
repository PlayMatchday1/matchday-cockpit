// GET /api/manager-pay/manager-year?year=YYYY[&manager=<email>]
//
// ADMIN ONLY (authenticateCapability). One manager's full year is a different thing
// from one week everyone can see — this is deliberately NOT on the shared-token
// surface. Without ?manager, returns the manager select for that year; with it,
// the full derived year report (src/lib/managerYearReport.ts).

import { authenticateCapability } from "@/lib/capabilityAuth";
import { buildYearReport, listYearManagers } from "@/lib/managerYearReport";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const yearRaw = url.searchParams.get("year");
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : new Date().getUTCFullYear();
  const manager = url.searchParams.get("manager");

  try {
    if (!manager) {
      const managers = await listYearManagers(auth.supabase, year);
      return Response.json({ year, managers });
    }
    const report = await buildYearReport(auth.supabase, manager, year, new Date());
    return Response.json(report);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
