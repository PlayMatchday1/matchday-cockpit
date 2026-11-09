/* POST /api/lifecycle/churn/message { personId } — Churn's "Message" button (2026-11-09).
 *
 * Finds the player's WhatsApp thread in Player Chats, or CREATES ONE the way the WhatsApp webhook would (phone,
 * channel, player, account city), and returns its id for the page to open. NOTHING IS SENT: the staff member
 * writes the template themselves in Player Chats.
 *
 * It also notes a PENDING win-back (churn_winback, message_id null) for this staff member on this thread. The
 * send routes (/api/crm/send, /api/crm/send-template) fill it in when that staff member's next message on the
 * thread actually goes out (churnWinback.markWinbackSent); only then does Churn show "Messaged [date]".
 *
 * Who: Player Chats access AND SEND MESSAGES (read fresh by authenticateCrm); a city-confined account only in its
 * city (assertThreadInScope). */
import { authenticateCrm } from "@/lib/crmAuth";
import { assertThreadInScope } from "@/lib/crmScope";
import { accountCityCode } from "@/lib/crmThreadCity";
import { normalizePhone } from "@/lib/phone";

export const runtime = "nodejs";

type Row = Record<string, unknown>;

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.email) return Response.json({ error: "Couldn't confirm who you are. Sign in again." }, { status: 401 });
  if (!(auth.isAdmin || auth.canAccessChats) || !auth.canSendMessages) {
    return Response.json({ error: "Messaging a player needs Player Chats and SEND MESSAGES." }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { personId?: unknown } | null;
  const personId = Number(body?.personId);
  if (!Number.isInteger(personId) || personId <= 0) return Response.json({ error: "A numeric personId is required." }, { status: 400 });
  const sb = auth.supabase;

  // The person's accounts: their own id plus any deleted account growth_person_link maps onto them.
  const { data: links, error: lErr } = await sb.from("growth_person_link").select("account_id").eq("person_id", personId);
  if (lErr) return Response.json({ error: lErr.message }, { status: 500 });
  const accounts = [personId, ...((links ?? []) as Row[]).map((l) => Number(l.account_id))];

  const { data: user, error: uErr } = await sb.from("mdapi_users").select("id, phone_number").eq("id", personId).maybeSingle();
  if (uErr) return Response.json({ error: uErr.message }, { status: 500 });
  const phone = normalizePhone((user as Row | null)?.phone_number as string | null);

  // 1. Their WhatsApp thread: linked to one of their accounts, else on their phone.
  let threadId: string | null = null;
  const byPlayer = await sb.from("crm_threads").select("id").eq("channel", "whatsapp").in("player_id", accounts)
    .order("last_message_at", { ascending: false }).limit(1);
  if (byPlayer.error) return Response.json({ error: byPlayer.error.message }, { status: 500 });
  threadId = ((byPlayer.data ?? []) as Row[])[0]?.id as string | undefined ?? null;
  if (!threadId && phone) {
    const byPhone = await sb.from("crm_threads").select("id").eq("channel", "whatsapp").eq("phone_number", phone).maybeSingle();
    if (byPhone.error) return Response.json({ error: byPhone.error.message }, { status: 500 });
    threadId = (byPhone.data as Row | null)?.id as string | undefined ?? null;
  }

  // 2. None: open one, as the webhook does for a first inbound (no message is written).
  let created = false;
  if (!threadId) {
    if (!phone) return Response.json({ error: "This player has no phone number on file, so there is no WhatsApp chat to open." }, { status: 422 });
    const city = await accountCityCode(sb, personId);
    const ins = await sb.from("crm_threads").insert({
      phone_number: phone, channel: "whatsapp", player_id: personId,
      ...(city ? { city_code: city, city_source: "account" } : {}),
      last_message_at: new Date().toISOString(), last_message_preview: "",
    }).select("id").single();
    if (ins.error || !ins.data) return Response.json({ error: `Could not open a chat: ${ins.error?.message ?? "no row"}` }, { status: 500 });
    threadId = String((ins.data as Row).id);
    created = true;
  }

  const scope = await assertThreadInScope(auth, threadId);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });

  // 3. The pending win-back. Filled in by the send routes when this staff member's message goes out.
  const wb = await sb.from("churn_winback").insert({ person_id: personId, account_id: personId, thread_id: threadId, messaged_by: auth.email.toLowerCase() });
  if (wb.error) console.warn(`[churn] pending win-back not recorded for ${personId}: ${wb.error.message}`);

  return Response.json({ threadId, created, pendingRecorded: !wb.error });
}
