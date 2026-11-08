// GUEST PASS DRY RUN, read-only, on demand (NOT in `npm run verify`): every guest pass request in the last
// 30 days through src/lib/guestPass.ts, as of the moment the player asked, from our database copy only (no
// MatchDay reads). Nothing is written or sent. Output carries player ids and message text: read it, don't paste it.
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/guest-pass-dry-run.mts
import { readFileSync } from "node:fs";
for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const { createClient } = await import("@supabase/supabase-js");
const { loadGuestPassFacts } = await import("../src/lib/guestPassLoad");
const { decideGuestPass, guestPassForModel } = await import("../src/lib/guestPass");
const { staffConfirmedMembership } = await import("../src/lib/aiDraftAction");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
const since = new Date(Date.now() - 30 * 864e5).toISOString();
const RX = /guest|passes|pase|invitad|\bfp\b|bring (?:a |my )?friends?\b/i;
const inb = await sb.from("crm_messages").select("id, thread_id, body, sent_at").eq("direction", "inbound").gte("sent_at", since).order("sent_at");
const gd = await sb.from("crm_ai_drafts").select("thread_id, based_on_message_id").eq("category", "guest_pass").gte("created_at", since);
const gdIds = new Set((gd.data ?? []).map((d) => d.based_on_message_id));
const asks = (inb.data ?? []).filter((m) => RX.test(m.body ?? "") || gdIds.has(m.id));
const seen = new Set<string>();
for (const a of asks) {
  const key = a.thread_id + a.sent_at.slice(0, 10);
  if (seen.has(key)) continue; seen.add(key);
  const t = (await sb.from("crm_threads").select("player_id, phone_number, match_ambiguous, account_confirmed_at, city_code").eq("id", a.thread_id).single()).data!;
  const at = Date.parse(a.sent_at);
  let membership = null as null | { id: number; statusRaw: string; price: number | null; canceledAt: string | null; since: string | null };
  if (t.player_id) {
    const subs = (await sb.from("mdapi_subscriptions").select("membership_id, status, price, canceled_at, activation_date").eq("user_id", t.player_id)).data ?? [];
    // The membership row that was live when they asked: started by then and still ACTIVE now (a cancel inside
    // the month keeps it active through the month; its canceled_at counts only if it was before the ask).
    const liveThen = subs.filter((s) => s.status === "ACTIVE" && s.activation_date && Date.parse(s.activation_date) <= at)
      .sort((x, y) => Date.parse(y.activation_date) - Date.parse(x.activation_date))[0];
    if (liveThen) membership = { id: Number(liveThen.membership_id), statusRaw: "ACTIVE", price: liveThen.price == null ? null : Number(liveThen.price) * 100, canceledAt: liveThen.canceled_at && Date.parse(liveThen.canceled_at) <= at ? liveThen.canceled_at : null, since: liveThen.activation_date };
  }
  const confirmed = !!t.player_id && (!t.match_ambiguous || !!t.account_confirmed_at);
  const staff = (await sb.from("crm_messages").select("body, sent_by_user_id, sent_at").eq("thread_id", a.thread_id).eq("direction", "outbound").lt("sent_at", a.sent_at)).data ?? [];
  let ans;
  if (!confirmed) ans = { kind: "ask_phone" as const };
  else {
    const f = await loadGuestPassFacts(sb, { playerId: t.player_id, threadPhone: t.phone_number, membership, accountConfirmed: true, staffConfirmed: staffConfirmedMembership(staff.filter((m) => m.sent_by_user_id).map((m) => m.body ?? "")), now: at });
    // As of the ask: a code created after the player wrote didn't exist yet.
    if (f.codes) {
      const created = new Map(((await sb.from("mdapi_promocodes").select("api_id, created_at").in("api_id", f.codes.map((c) => c.api_id))).data ?? []).map((r) => [Number(r.api_id), Date.parse(r.created_at)]));
      f.codes = f.codes.filter((c) => (created.get(c.api_id) ?? 0) <= at);
      // Uses as of the ask: standing bookings that existed then.
      for (const c of f.codes) {
        const b = (await sb.from("mdapi_match_players").select("created_at, paid_status, is_cancelled, canceled_at, refunded, deleted_at").eq("promocode_id", c.api_id)).data ?? [];
        c.used = b.filter((x) => Date.parse(x.created_at) <= at && !x.deleted_at && !x.is_cancelled && !x.canceled_at && !x.refunded && x.paid_status !== "WAITING").length;
      }
    }
    ans = decideGuestPass(f);
  }
  const fill = "code" in ans ? ans.code : "";
  const say = guestPassForModel(ans)!.say.replace(/\{code\}/g, fill);
  const reply = (() => { const q = say.match(/"([^"]+)"/); return q ? q[1].replace(/\{code\}/g, fill) : say; })();
  console.log(JSON.stringify({ asked: a.sent_at.slice(0, 16), player: t.player_id, city: t.city_code, said: (a.body ?? "").slice(0, 110), answer: ans.kind, code: fill || null, reason: "reason" in ans ? ans.reason : null, would_send: ans.kind === "person" ? "(nothing: a person handles it)" : reply }));
}
