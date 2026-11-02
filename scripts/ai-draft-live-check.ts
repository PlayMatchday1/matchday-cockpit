// CLAUDE DRAFTS — a LIVE check against the real model, on demand only (NOT in `npm run verify`:
// it costs money and needs a key). Synthetic threads, no real player data, the real playbook, and
// the REAL orchestration (runDraft): the same clock, schedule, request and guards the route uses,
// with fake data in place of Supabase and the MatchDay API. Writes nothing to the database and
// sends nothing to anyone.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/ai-draft-live-check.ts [--time]
//
// --time runs only the time-awareness threads; --next-step only the 2026-10-22 next-step/apology ones; --phase2 only the 2026-10-31 action, length and camera ones. Reads ANTHROPIC_API_KEY from .env.local (never
// printed). About $0.03 a thread. That spend is NOT recorded in crm_ai_drafts, so it does not count
// toward the $20 draft cap.

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { assertAnthropicHost, draftCostUsd, hasDash, toApiRequest, type DraftContextIn, type DraftMsg } from "../src/lib/aiDraftModel";
import { runDraft, type DraftResult, type NewDraftRow } from "../src/lib/aiDraftRun";
import { timesIn, type ScheduleRow } from "../src/lib/aiDraftClock";
import { playbookForModel } from "../src/lib/aiDraftPlaybook";

const env = readFileSync(".env.local", "utf8");
const apiKey = env.match(/^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "");
if (!apiKey) { console.error("ANTHROPIC_API_KEY not found in .env.local"); process.exit(2); }

const H = 3600e3;
let n = 0;
const at = (iso: string, direction: "inbound" | "outbound", body: string): DraftMsg => ({ id: `m${++n}`, direction, body, sent_at: iso });
const ago = (now: number, ms: number) => new Date(now - ms).toISOString();

const linked = (over: Partial<DraftContextIn> = {}): DraftContextIn => ({
  linked: true, ambiguous: false, firstName: "Sam", city: "Houston", cityCode: "HOU", isMember: false, membership: null,
  creditsCents: 0, matchesPlayed: 9, priorCourtesyCredit: false, strikes: { active: 0, limit: 4, suspended: false }, matches: [], ...over,
});
const unlinked: DraftContextIn = { linked: false, ambiguous: false, firstName: null, city: null, isMember: null, membership: null, creditsCents: null, matchesPlayed: null, strikes: null, matches: [] };

// A synthetic field, "Oak Hollow", in Houston. Wall clock + the matching instant (CDT = UTC-5).
const row = (id: number, wall: string, extra: Partial<ScheduleRow> = {}): ScheduleRow => ({
  api_id: id, field_title: "Oak Hollow", start_date: `${wall}:00.000Z`,
  start_date_utc: new Date(Date.parse(`${wall}:00.000Z`) + 5 * H).toISOString(),
  city_identifier: "HOU", is_cancelled: false, player_count: 12, max_player_count: 18, ...extra,
});

type Case = { name: string; time?: boolean; nextStep?: boolean; phase2?: boolean; channel?: "whatsapp" | "sms"; now: number; ctx: DraftContextIn; msgs: DraftMsg[]; rows?: ScheduleRow[]; expect: (r: DraftResult, req: string) => string | null };

const T = Date.parse("2026-10-21T12:38:00.000Z"); // Wed Oct 21, 7:38 AM Central
// An apology anywhere in the reply's first sentence, or a sorry for the wait anywhere at all.
const apologizes = (t: string) => /\b(sorry|apolog)/i.test(t.split(/(?<=[.!?])\s/)[0] ?? "") || /slow (reply|response)|sorry (for|about) the (wait|delay)/i.test(t);
const okText = (r: DraftResult) => (r.status === "ok" ? null : `not shown: ${"message" in r ? r.message : r.status}`);
const CASES: Case[] = [
  {
    name: "NEXT 1: unlinked number, cancelled 2 of 3 bookings, wants a 'refund', answered 15h later",
    nextStep: true, now: T, ctx: unlinked,
    msgs: [
      at(ago(T, 15.2 * H), "inbound", "Hi I booked 3 spots for Saturday at Oak Hollow and cancelled 2 of them on Wednesday"),
      at(ago(T, 15 * H), "inbound", "I cancelled way before the deadline. I want a refund for the 2 spots, $8 each back to my card please"),
    ],
    expect: (r) => okText(r) ?? (r.status !== "ok" ? null
      : apologizes(r.draft.text) ? "apologized"
      : !/credit/i.test(r.draft.text) ? "no credit answer"
      : !/(24 hours|day before)/i.test(r.draft.text) ? "did not state the 24 hour rule"
      : !/automatic/i.test(r.draft.text) ? "did not say the credit is automatic"
      : !/phone number/i.test(r.draft.text) ? "did not ask for the account phone number"
      : /e-?mail/i.test(r.draft.text) ? "asked for an email"
      : !/(I'll|I will|let me|once I|then I)/i.test(r.draft.text) ? "did not say what happens next"
      : /\brefund(ed)? (is|will|has)/i.test(r.draft.text) ? "promised a refund"
      : r.draft.staff_notes[0] !== "No account found for this number." ? "reason line not first"
      : r.draft.staff_notes.slice(1).some((x) => /no account|unconfirmed|unlinked/i.test(x)) ? "a later bullet restates the account status"
      : null),
  },
  {
    name: "NEXT 2: simple question answered 5h late → no apology, just the answer",
    nextStep: true, now: T, ctx: linked(),
    msgs: [at(ago(T, 5 * H), "inbound", "Do I need cleats or are turf shoes fine?")],
    expect: (r) => okText(r) ?? (r.status === "ok" && apologizes(r.draft.text) ? "apologized" : r.status === "ok" && !/(turf|cleats)/i.test(r.draft.text) ? "did not answer" : null),
  },
  {
    name: "NEXT 3: a match WE cancelled → the apology stays",
    nextStep: true, now: T, ctx: linked({ matches: [{ name: "Oak Hollow 8v8", startDate: "2026-10-20T19:00:00.000Z", startDateUtc: "2026-10-21T00:00:00.000Z", state: "club_cancelled", price: 1200, charged: 1299, playerCancelledAt: null }] }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "Got a text that last night's game was cancelled. Do I get my money back?")],
    expect: (r) => okText(r) ?? (r.status === "ok" && !/\b(sorry|apolog)/i.test(r.draft.text) ? "no apology for a match we cancelled" : r.status === "ok" && !/credit/i.test(r.draft.text) ? "no credit answer" : null),
  },
  {
    name: "NEXT 4: SMS simple question answered 30h late → sorry for the wait",
    nextStep: true, channel: "sms", now: T, ctx: linked(),
    msgs: [at(ago(T, 30 * H), "inbound", "Do I need cleats or are turf shoes fine?")],
    expect: (r) => okText(r) ?? (r.status === "ok" && !/\b(sorry|apolog)/i.test(r.draft.text.split(/(?<=[.!?])\s/)[0]) ? "no sorry after a 30h wait" : null),
  },
  {
    name: "TIME 1: asked yesterday 3:38 PM about 'tonight at Oak Hollow', answered 16h later (no apology: under 24h)",
    time: true, now: T, ctx: linked(),
    msgs: [at("2026-10-20T20:38:00.000Z", "inbound", "Hey are there still 2 games tonight at Oak Hollow? Want to bring a friend")],
    rows: [row(101, "2026-10-20T19:00"), row(102, "2026-10-20T20:15"), row(103, "2026-10-22T19:30", { player_count: 14 }), row(104, "2026-10-24T09:00")],
    expect: (r) => r.status !== "ok" ? `not shown: ${"message" in r ? r.message : r.status}` : apologizes(r.draft.text) ? "apologized for a 16h wait" : !/(last night|yesterday|already)/i.test(r.draft.text) ? "did not treat it as past" : !/7:30/.test(r.draft.text) ? "no next real time" : null,
  },
  {
    name: "TIME 2: asked 30 min ago about tonight at Oak Hollow (on time)",
    time: true, now: T + 11 * H, ctx: linked(), // Wed 6:38 PM
    msgs: [at(ago(T + 11 * H, 0.5 * H), "inbound", "Any spots left tonight at Oak Hollow?")],
    rows: [row(201, "2026-10-21T19:30", { player_count: 15 }), row(202, "2026-10-21T20:45", { player_count: 18 }), row(203, "2026-10-23T19:30")],
    expect: (r) => r.status !== "ok" ? `not shown: ${"message" in r ? r.message : r.status}` : /slow|delay|sorry for the wait/i.test(r.draft.text) ? "apologized when on time" : !/7:30/.test(r.draft.text) ? "did not give tonight's real time" : null,
  },
  {
    name: "TIME 3: Veo question answered 5h late → no apology of any kind",
    time: true, now: T, ctx: linked({ matches: [] }),
    msgs: [at(ago(T, 5 * H), "inbound", "When does the video from Monday night's game go up?")],
    expect: (r) => r.status !== "ok" ? `not shown: ${"message" in r ? r.message : r.status}` : apologizes(r.draft.text) ? "apologized" : !/24 to 48|24-48/.test(r.draft.text) ? "no 24 to 48 hours" : /sorry (it|the video|for the video)|apolog\w* (for|about) the (video|delay in)/i.test(r.draft.text) ? "apologized for video timing" : /(more than|over) 48 hours|should (be up|have been posted) by now/i.test(r.draft.text) ? "worked out an elapsed time it had no data for" : null,
  },
  {
    name: "no courtesy yet, late cancel → courtesy offered",
    now: T, ctx: linked({ matchesPlayed: 0, matches: [{ name: "Westlake 8v8", startDate: "2026-10-21T06:30:00.000Z", startDateUtc: "2026-10-21T11:30:00.000Z", state: "player_cancelled", price: 1200, charged: 1299, playerCancelledAt: "2026-10-21T08:30:00.000Z" }] }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "Hey I had to cancel this morning's game 3 hours before, my car broke down. Any way I can get a credit?")],
    expect: (r) => (r.status === "ok" && /credit/i.test(r.draft.text) ? null : "expected a courtesy offer"),
  },
  {
    name: "already had a courtesy, late cancel → no courtesy",
    now: T, ctx: linked({ matchesPlayed: 14, priorCourtesyCredit: true, matches: [{ name: "Westlake 8v8", startDate: "2026-10-21T06:30:00.000Z", startDateUtc: "2026-10-21T11:30:00.000Z", state: "player_cancelled", price: 1200, charged: 1299, playerCancelledAt: "2026-10-21T08:30:00.000Z" }] }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "Hey I had to cancel this morning's game 3 hours before, my car broke down. Any way I can get a credit?")],
    expect: (r) => (r.status === "ok" && !/one.time credit|courtesy/i.test(r.draft.text) ? null : "offered a second courtesy"),
  },
  {
    name: "member asks to pause → no hold offered, Ryan flagged",
    now: T, ctx: linked({ isMember: true, membership: { status: "ACTIVE", since: "2026-06-12T00:00:00Z", renews: "2026-11-01T00:00:00Z", canceledAt: null, price: 6650 } }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "I hurt my ankle and can't play for a couple months, can I pause my membership?")],
    expect: (r) => (r.status === "ok" && r.draft.staff_notes.some((x) => /Hold requested: tell Ryan/i.test(x)) ? null : "expected the hold note"),
  },
  {
    name: "14-year-old → age rule, Under 16 flagged",
    now: T, ctx: unlinked,
    msgs: [at(ago(T, 0.5 * H), "inbound", "Hi! I'm 14, can I play in your games?")],
    expect: (r) => (r.status === "ok" && (r.draft.flags.includes("under_16") || r.draft.staff_notes.some((x) => /under 16/i.test(x))) ? null : "expected the Under 16 flag"),
  },
  {
    name: "unlinked number asks about credit → asks for the account's phone",
    now: T, ctx: unlinked,
    msgs: [at(ago(T, 0.5 * H), "inbound", "Hey where's my credit from the game that got cancelled last night?")],
    expect: (r) => (r.status === "ok" && /phone number/i.test(r.draft.text) && !/\$\d/.test(r.draft.text) ? null : "expected an ask for the phone number and no amounts"),
  },
  // Phase 2, 2026-10-31: short replies, a proposed action, camera answers from data only, no closing offer.
  {
    name: "PHASE2: late cancel, no courtesy yet: proposes the match price, both versions",
    phase2: true, now: T, ctx: linked({ priorCourtesyCredit: false, creditsCents: 300, matches: [{ name: "Oak Hollow 8v8", startDate: "2026-10-21T19:00:00.000Z", startDateUtc: "2026-10-22T00:00:00.000Z", state: "player_cancelled", price: 800, charged: 866, playerCancelledAt: ago(T, 1 * H) }] }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "I had to cancel tonight, I'm sick. Can I get a credit?")],
    expect: (r) => (r.status !== "ok" ? okText(r) : r.draft.action?.kind !== "credit" ? "no credit action" : r.draft.action.amount_cents !== 800 ? `amount ${r.draft.action.amount_cents}` : !r.draft.text_without_action ? "no version without the action" : null),
  },
  {
    name: "PHASE2: already had a courtesy: no action, no offer",
    phase2: true, now: T, ctx: linked({ priorCourtesyCredit: true, matches: [{ name: "Oak Hollow 8v8", startDate: "2026-10-21T19:00:00.000Z", startDateUtc: "2026-10-22T00:00:00.000Z", state: "player_cancelled", price: 800, charged: 866, playerCancelledAt: ago(T, 1 * H) }] }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "I had to cancel tonight, I'm sick. Can I get a credit?")],
    expect: (r) => (r.status !== "ok" ? okText(r) : r.draft.action ? "proposed an action" : null),
  },
  {
    name: "PHASE2: camera question answers from recorded_fields, one or two sentences",
    phase2: true, now: T, ctx: linked({ priorCourtesyCredit: false, recordedFields: [{ field: "Oak Hollow", recorded_matches: 3, matches: 14, last_recorded: "Tue, Oct 20, 8:00 PM", next_recorded: "Thu, Oct 22, 7:00 PM" }] }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "does oak hollow have a camera?")],
    expect: (r) => (r.status !== "ok" ? okText(r) : r.draft.text.split(/(?<=[.!?])\s/).length > 2 ? "more than 2 sentences" : /(let me know|message us|reach out|anything (else|comes up))/i.test(r.draft.text) ? "closing offer" : null),
  },
  {
    name: "PHASE2: member asks for guest passes: proposes a code with the placeholder",
    phase2: true, now: T, ctx: linked({ priorCourtesyCredit: false, isMember: true, membership: { status: "ACTIVE", since: "2026-01-12T00:00:00Z", renews: "2026-11-01T00:00:00Z", canceledAt: null, price: 6650 } }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "How do I get the 3 guest passes for my membership?")],
    expect: (r) => (r.status !== "ok" ? okText(r) : r.draft.action?.kind !== "issue_guest_code" ? "no guest code action" : !r.draft.text.includes("{code}") ? "no placeholder" : null),
  },
  {
    name: "PHASE2: member asks how to cancel: in-app steps, no action, the cancel note",
    phase2: true, now: T, ctx: linked({ priorCourtesyCredit: false, isMember: true, membership: { status: "ACTIVE", since: "2026-01-12T00:00:00Z", renews: "2026-11-01T00:00:00Z", canceledAt: null, price: 6650 } }),
    msgs: [at(ago(T, 0.5 * H), "inbound", "Cancel my membership please")],
    expect: (r) => (r.status !== "ok" ? okText(r) : r.draft.action ? "proposed an action" : !r.draft.staff_notes.some((n) => /Cancel requested/.test(n)) ? "no cancel note" : null),
  },
];

async function main() {
  const playbook = playbookForModel(readFileSync("docs/support/PLAYBOOK.md", "utf8"));
  const client = new Anthropic({ apiKey, baseURL: "https://api.anthropic.com", maxRetries: 0, timeout: 60_000 });
  assertAnthropicHost(client.baseURL);
  const only = process.argv.includes("--time") ? "time" : process.argv.includes("--next-step") ? "next" : process.argv.includes("--phase2") ? "phase2" : null;
  let bad = 0, cost = 0, ran = 0;
  for (const c of CASES.filter((x) => !only || (only === "time" ? x.time : only === "phase2" ? x.phase2 : x.nextStep))) {
    ran++;
    let reqText = "";
    const inserts: NewDraftRow[] = [];
    const r = await runDraft({
      threadId: "synthetic", requestedBy: null, regenerate: false, now: () => c.now, hasKey: true,
      loadThread: async () => ({ channel: c.channel ?? "whatsapp", player_id: c.ctx.linked ? 1 : null, match_ambiguous: false, account_confirmed: false }),
      loadMessages: async () => c.msgs,
      latestDraftFor: async () => null,
      supersedePending: async () => {},
      monthSpendUsd: async () => 0,
      countAccounts: async () => 0,
      findAccountsByPhone: async () => [],
      priorCategory: async () => null,
      loadExampleMessages: async () => [],
      appliedActions: async () => [],
      loadContext: async () => ({ ctx: c.ctx, keys: ["synthetic"] }),
      loadScheduleRows: async () => c.rows ?? [],
      playbook: () => ({ text: playbook, version: "live-check" }),
      callModel: async (req) => {
        reqText = req.messages[0].content;
        const t0 = Date.now();
        const res = await client.messages.create(toApiRequest(req));
        console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s, ${res.usage.input_tokens} in, ${res.usage.output_tokens} out, ${res.stop_reason}]`);
        cost += draftCostUsd(res.usage);
        return { text: res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim() || null, stopReason: res.stop_reason, usage: res.usage };
      },
      insertDraft: async (row) => { inserts.push(row); return { id: `d${inserts.length}`, created_at: new Date(c.now).toISOString() }; },
    });
    console.log(`\n── ${c.name}`);
    const clock = reqText.match(/"latest_player_message": "([^"]+)"[\s\S]*?"reply_is_very_late": (true|false)/);
    if (clock) console.log(`  clock: player wrote ${clock[1]} · very late=${clock[2]}`);
    if (r.status === "ok") {
      console.log(`  reply: ${r.draft.text}`);
      if (r.draft.action) console.log(`  action: ${JSON.stringify(r.draft.action)}\n  without: ${r.draft.text_without_action}`);
      console.log(`  notes: ${r.draft.staff_notes.map((x) => `\n    - ${x}`).join("")}${r.draft.flags.length ? `\n  flags: ${r.draft.flags.join(", ")}` : ""}`);
      const schedTimes = (c.rows ?? []).length ? timesIn(reqText.slice(reqText.indexOf("SCHEDULE"), reqText.indexOf("CONVERSATION"))) : [];
      if (timesIn(r.draft.text).length) console.log(`  times in reply: ${timesIn(r.draft.text).join(", ")} · in schedule: ${schedTimes.join(", ") || "(none)"}`);
      if (hasDash(r.draft.text)) { bad++; console.log("  ✗ dash in the draft"); }
      if (r.draft.staff_notes.length > 3) { bad++; console.log("  ✗ more than 3 note bullets"); }
      const keys = r.draft.staff_notes.map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
      if (new Set(keys).size !== keys.length) { bad++; console.log("  ✗ a staff note repeats"); }
    } else {
      console.log(`  NOT SHOWN: ${"message" in r ? r.message : r.status}`);
    }
    const miss = c.expect(r, reqText);
    if (miss) { bad++; console.log(`  ✗ ${miss}`); } else console.log("  ✓ as expected");
  }
  console.log(`\n${ran - bad}/${ran} as expected · cost $${cost.toFixed(4)}`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
