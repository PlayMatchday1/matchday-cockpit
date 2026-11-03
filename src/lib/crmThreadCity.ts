// The thread's city from an account (crm_threads.city_code, migration 0250). Shared by both inbound
// webhooks, so a first message from a known player lands in that player's city's inbox at once.
// Never throws: a webhook must not fail on a city lookup.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCityScope } from "@/lib/cityScope";

export async function accountCityCode(sb: SupabaseClient, playerId: number): Promise<string | null> {
  try {
    const r = await sb.from("mdapi_users").select("preferable_city_normalized").eq("id", playerId).maybeSingle();
    if (r.error) return null;
    return resolveCityScope((r.data?.preferable_city_normalized as string | null) ?? null)?.identifier ?? null;
  } catch {
    return null;
  }
}
