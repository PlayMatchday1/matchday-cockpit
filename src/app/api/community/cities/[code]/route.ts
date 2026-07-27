// PATCH /api/community/cities/[code] — edit a city's invite URL and/or active
// flag. Admin-only. Validates the URL is a chat.whatsapp.com invite, and
// refuses to activate a city with no URL (never post a broken/empty link).

import { authenticateAdmin } from "@/lib/adminAuth";
import { isValidWhatsAppInviteUrl } from "@/lib/community";

export const runtime = "nodejs";
export const maxDuration = 15;

type Ctx = { params: Promise<{ code: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { code } = await ctx.params;
  if (!code || !/^[A-Za-z]{2,6}$/.test(code)) {
    return Response.json({ error: "Invalid city code" }, { status: 400 });
  }
  const cityCode = code.toUpperCase();

  const body = (await req.json().catch(() => null)) as
    | { whatsapp_url?: unknown; active?: unknown }
    | null;
  if (!body) return Response.json({ error: "Invalid request body." }, { status: 400 });

  // The row must exist (cities are seeded by the migration).
  const cur = await auth.supabase
    .from("city_community_links")
    .select("city_code, whatsapp_url, active")
    .eq("city_code", cityCode)
    .maybeSingle();
  if (cur.error) {
    console.error("[community:cities] load failed", cur.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!cur.data) return Response.json({ error: "Unknown city" }, { status: 404 });

  const update: { whatsapp_url?: string | null; active?: boolean; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };

  // URL edit: empty/whitespace clears it; anything else must be a valid invite.
  let effectiveUrl: string | null = (cur.data.whatsapp_url as string | null) ?? null;
  if (typeof body.whatsapp_url === "string") {
    const trimmed = body.whatsapp_url.trim();
    if (trimmed === "") {
      update.whatsapp_url = null;
      effectiveUrl = null;
    } else if (!isValidWhatsAppInviteUrl(trimmed)) {
      return Response.json(
        { error: "URL must be a chat.whatsapp.com invite link." },
        { status: 400 },
      );
    } else {
      update.whatsapp_url = trimmed;
      effectiveUrl = trimmed;
    }
  }

  // Active edit: can't go live without a URL on file.
  if (typeof body.active === "boolean") {
    if (body.active && !effectiveUrl) {
      return Response.json(
        { error: "Add a WhatsApp invite URL before activating this city." },
        { status: 400 },
      );
    }
    update.active = body.active;
  }

  const upd = await auth.supabase
    .from("city_community_links")
    .update(update)
    .eq("city_code", cityCode)
    .select("city_code")
    .maybeSingle();
  if (upd.error) {
    console.error("[community:cities] update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  console.log(`[community:cities] ${cityCode} updated by ${auth.appUserId}`);
  return Response.json({ ok: true }, { status: 200 });
}
