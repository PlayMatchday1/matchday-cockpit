// Manager Pay shareable-link management — ADMIN ONLY (authenticateAdmin).
//
//   GET  → { hasToken, rotatedAt } — metadata for the admin view. NEVER returns
//          the token or its hash.
//   POST → rotate: mint a new token, store only its SHA-256 hash, and return the
//          plaintext ONCE so the admin can copy the link. Rotating invalidates
//          the previous link immediately (single-row table, hash overwritten).
//
// A token-authenticated caller (the public share token) has no session Bearer and
// is rejected 401 here — this endpoint is unreachable with just the share link.

import { authenticateAdmin } from "@/lib/adminAuth";
import { generateShareToken } from "@/lib/managerPayShareToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { data, error } = await auth.supabase
    .from("manager_pay_share_token")
    .select("rotated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ hasToken: !!data, rotatedAt: (data?.rotated_at as string) ?? null });
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { token, hash } = generateShareToken();
  const { data, error } = await auth.supabase
    .from("manager_pay_share_token")
    .upsert(
      { id: 1, token_hash: hash, rotated_by: auth.appUserId, rotated_at: new Date().toISOString() },
      { onConflict: "id" },
    )
    .select("rotated_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  // Plaintext returned once — never stored, cannot be read back.
  return Response.json({ token, rotatedAt: data.rotated_at as string });
}
