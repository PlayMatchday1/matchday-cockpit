// GET /api/crm/players/search?q=<phone or name> — find an account to link a Player Chats thread to.
//
// Its own route, not /api/lookup, because /api/lookup is gated on Match Ops read and linking must
// follow the Player Chats rule (authenticateCrm: can_access_chats or is_admin). Reads our mirror,
// mdapi_users.
//
//   phone   7+ digits typed in any format. DIGITS ONLY: (512) 555-0100, 512-555-0100 and
//           +15125550100 are one number. Matched exactly against both stored shapes.
//   name    every word must appear in the first or last name (case-insensitive).
//
// A city-confined account only sees players in its city. Results carry the phone's LAST FOUR
// digits, not the whole number.

import { authenticateCrm } from "@/lib/crmAuth";
import { resolveCityScope, cityNameFor } from "@/lib/cityScope";
import { phoneDigits10, phoneShapes } from "@/lib/aiDraftModel";

export const runtime = "nodejs";

type Row = { id: number; first_name: string | null; last_name: string | null; phone_number: string | null; preferable_city_normalized: string | null; is_member: boolean | null; created_at: string | null };

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { supabase } = auth;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ results: [] });

  const cols = "id, first_name, last_name, phone_number, preferable_city_normalized, is_member, created_at";
  let rows: Row[] = [];
  const digits = phoneDigits10(q);
  if (digits) {
    const r = await supabase.from("mdapi_users").select(cols).in("phone_number", phoneShapes(digits)).limit(20);
    if (r.error) return Response.json({ error: "Search failed." }, { status: 500 });
    rows = (r.data ?? []) as Row[];
  } else if (/\d{4,}/.test(q.replace(/\D/g, ""))) {
    return Response.json({ results: [], note: "Type the full 10-digit phone number." });
  } else {
    const words = q.split(/\s+/).filter((w) => w.length > 0 && !/[,()%]/.test(w)).slice(0, 3);
    if (!words.length) return Response.json({ results: [] });
    let query = supabase.from("mdapi_users").select(cols);
    for (const w of words) query = query.or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%`);
    const r = await query.order("created_at", { ascending: false }).limit(25);
    if (r.error) return Response.json({ error: "Search failed." }, { status: 500 });
    rows = (r.data ?? []) as Row[];
  }

  if (auth.confinedCity) rows = rows.filter((u) => resolveCityScope(u.preferable_city_normalized)?.identifier === auth.confinedCity);

  return Response.json({
    results: rows.slice(0, 10).map((u) => {
      const city = resolveCityScope(u.preferable_city_normalized)?.identifier ?? null;
      return {
        id: u.id,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || `Player ${u.id}`,
        city: city ? cityNameFor(city) ?? city : null,
        phone_last4: (u.phone_number ?? "").replace(/\D/g, "").slice(-4) || null,
        is_member: u.is_member === true,
        joined: u.created_at,
      };
    }),
  }, { headers: { "cache-control": "no-store" } });
}
