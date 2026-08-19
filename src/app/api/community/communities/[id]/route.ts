// PATCH /api/community/communities/[id] — edit a community's invite URL and/or
// active flag. Admin-only. Same rules as the old per-city route: the URL must
// be a chat.whatsapp.com invite, you can't activate without a URL, and
// activated_at stamps only on an inactive→active flip (so the poster's
// per-community floor starts now and can't backfill).

import { authenticateCapability } from "@/lib/capabilityAuth";
import { canonicalWhatsAppInviteUrl } from "@/lib/community";

export const runtime = "nodejs";
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const communityId = Number(id);
  if (!Number.isInteger(communityId) || communityId <= 0) {
    return Response.json({ error: "Invalid community id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { whatsapp_url?: unknown; active?: unknown }
    | null;
  if (!body) return Response.json({ error: "Invalid request body." }, { status: 400 });

  const cur = await auth.supabase
    .from("city_communities")
    .select("id, whatsapp_url, active")
    .eq("id", communityId)
    .maybeSingle();
  if (cur.error) {
    console.error("[community:communities] load failed", cur.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!cur.data) return Response.json({ error: "Unknown community" }, { status: 404 });

  const now = new Date().toISOString();
  const update: {
    whatsapp_url?: string | null;
    active?: boolean;
    activated_at?: string;
    updated_at: string;
  } = { updated_at: now };

  let effectiveUrl: string | null = (cur.data.whatsapp_url as string | null) ?? null;
  if (typeof body.whatsapp_url === "string") {
    const trimmed = body.whatsapp_url.trim();
    if (trimmed === "") {
      update.whatsapp_url = null;
      effectiveUrl = null;
    } else {
      const canonical = canonicalWhatsAppInviteUrl(trimmed);
      if (!canonical) {
        return Response.json(
          { error: "URL must be a chat.whatsapp.com invite link." },
          { status: 400 },
        );
      }
      update.whatsapp_url = canonical;
      effectiveUrl = canonical;
    }
  }

  if (typeof body.active === "boolean") {
    if (body.active && !effectiveUrl) {
      return Response.json(
        { error: "Add a WhatsApp invite URL before activating this community." },
        { status: 400 },
      );
    }
    update.active = body.active;
    if (body.active && cur.data.active !== true) update.activated_at = now;
  }

  const upd = await auth.supabase
    .from("city_communities")
    .update(update)
    .eq("id", communityId)
    .select("id")
    .maybeSingle();
  if (upd.error) {
    console.error("[community:communities] update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  console.log(`[community:communities] ${communityId} updated by ${auth.appUserId}`);
  return Response.json({ ok: true }, { status: 200 });
}
