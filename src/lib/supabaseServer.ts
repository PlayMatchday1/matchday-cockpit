// Service-role Supabase client for server-side rendering paths that
// need to bypass RLS — currently the public partner dashboard at
// /partners/[slug], which has to read mdapi_matches and
// mdapi_match_players for unauthenticated visitors. Those tables
// grant SELECT only TO authenticated; we don't want to relax that
// (player emails would leak), so the server fetches with elevated
// privilege and returns aggregated stats to the client.
//
// `server-only` makes Next.js / the bundler refuse to import this
// from any "use client" module — the SUPABASE_SERVICE_ROLE_KEY env
// stays out of the client bundle.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function makeServerClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase server env vars missing (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
