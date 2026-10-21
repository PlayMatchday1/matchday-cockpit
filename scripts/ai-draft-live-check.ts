// CLAUDE DRAFTS — a LIVE check against the real model, on demand only (NOT in `npm run verify`:
// it costs money and needs a key). Five synthetic threads, no real player data, the real playbook,
// the exact request the route sends. Writes nothing to the database and sends nothing to anyone.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/ai-draft-live-check.ts
//
// Reads ANTHROPIC_API_KEY from .env.local (never printed). About $0.10 to $0.20 a run. That spend is
// NOT recorded in crm_ai_drafts, so it does not count toward the $20 draft cap.

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildDraftContext, buildDraftRequest, parseDraftOutput, guardDraft, hasDash, draftCostUsd, assertAnthropicHost,
  type DraftContextIn, type DraftMsg,
} from "../src/lib/aiDraftModel";
import { playbookForModel } from "../src/lib/aiDraftPlaybook";

const env = readFileSync(".env.local", "utf8");
const apiKey = env.match(/^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "");
if (!apiKey) { console.error("ANTHROPIC_API_KEY not found in .env.local"); process.exit(2); }

const NOW = Date.now();
const H = 3600e3;
const iso = (ago: number) => new Date(NOW - ago).toISOString();
let n = 0;
const m = (direction: "inbound" | "outbound", body: string, ago: number): DraftMsg => ({ id: `m${++n}`, direction, body, sent_at: iso(ago) });
const kickoffUtc = new Date(NOW - 2 * H).toISOString();
const kickoffWall = new Date(NOW - 7 * H).toISOString(); // a Central wall clock wearing Z
const ctxBase = (played: number, member = false): DraftContextIn => ({
  linked: true, ambiguous: false, firstName: "Sam", city: "Austin", isMember: member,
  membership: member ? { status: "ACTIVE", since: "2026-06-12T00:00:00Z", renews: "2026-11-01T00:00:00Z", canceledAt: null, price: 6650 } : null,
  creditsCents: 0, matchesPlayed: played, strikes: { active: 0, limit: 4, suspended: false },
  matches: [{ name: "Westlake 8v8", startDate: kickoffWall, startDateUtc: kickoffUtc, state: "player_cancelled", price: 1200, charged: 1299, playerCancelledAt: new Date(Date.parse(kickoffUtc) - 3 * H).toISOString() }],
});

const CASES: { name: string; ctx: DraftContextIn; msgs: DraftMsg[]; expect: (o: NonNullable<ReturnType<typeof parseDraftOutput>>) => string | null }[] = [
  {
    name: "first-time player, late cancel → courtesy offered",
    ctx: ctxBase(0),
    msgs: [m("inbound", "Hey I had to cancel tonight's game 3 hours before, my car broke down. Any way I can get a credit?", 1 * H)],
    expect: (o) => (o.offers_courtesy_credit ? null : "expected a courtesy offer"),
  },
  {
    name: "returning player, late cancel → no courtesy",
    ctx: ctxBase(14),
    msgs: [m("inbound", "Hey I had to cancel tonight's game 3 hours before, my car broke down. Any way I can get a credit?", 1 * H)],
    expect: (o) => (!o.offers_courtesy_credit && !/one.time credit|courtesy/i.test(o.reply) ? null : "offered a courtesy to a returning player"),
  },
  {
    name: "Veo question → 24 to 48 hours, no apology",
    ctx: { ...ctxBase(9), matches: [] },
    msgs: [m("inbound", "When does the video from last night's game get posted?", 1 * H)],
    expect: (o) => (/24 to 48|24-48/.test(o.reply) && !/sorry|apolog/i.test(o.reply) ? null : "expected 24 to 48 hours, no apology"),
  },
  {
    name: "member asks to pause → no hold offered, Ryan flagged",
    ctx: { ...ctxBase(20, true), matches: [] },
    msgs: [m("inbound", "I hurt my ankle and can't play for a couple months, can I pause my membership?", 1 * H)],
    expect: (o) => (/Hold requested: tell Ryan/i.test(o.staff_notes) && !/(I('ve| have) (put|paused)|on hold for you|we can (put|pause))/i.test(o.reply) ? null : "expected the hold flag and no hold offer"),
  },
  {
    name: "14-year-old → age rule, Under 16 flagged",
    ctx: { ...ctxBase(0), linked: false, matchesPlayed: null, matches: [], firstName: null },
    msgs: [m("inbound", "Hi! I'm 14, can I play in your games?", 1 * H)],
    expect: (o) => (o.flags.includes("under_16") || /under 16/i.test(o.staff_notes) ? null : "expected the Under 16 flag"),
  },
];

async function main() {
  const playbook = playbookForModel(readFileSync("docs/support/PLAYBOOK.md", "utf8"));
  const client = new Anthropic({ apiKey, baseURL: "https://api.anthropic.com", maxRetries: 0, timeout: 60_000 });
  assertAnthropicHost(client.baseURL);
  let bad = 0, cost = 0;
  for (const c of CASES) {
    const ctx = buildDraftContext(c.ctx);
    const req = buildDraftRequest({ playbook, context: ctx, msgs: c.msgs, now: NOW });
    const res = await client.messages.create(req);
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    cost += draftCostUsd(res.usage);
    const parsed = parseDraftOutput(text);
    console.log(`\n── ${c.name}  [stop=${res.stop_reason} in=${res.usage.input_tokens} out=${res.usage.output_tokens}]`);
    if (!parsed) { bad++; console.log("  ✗ unparseable output:", text.slice(0, 300)); continue; }
    const rawDash = hasDash(parsed.reply);
    const g = guardDraft(parsed, ctx);
    const shown = g.ok ? g.output : parsed;
    console.log(`  reply: ${shown.reply}`);
    console.log(`  notes: ${shown.staff_notes}  flags=${JSON.stringify(shown.flags)} courtesy=${shown.offers_courtesy_credit}`);
    console.log(`  raw reply had a dash: ${rawDash}  | guard: ${g.ok ? "passed" : `REJECTED (${g.error})`}`);
    const miss = c.expect(parsed);
    const dashOut = g.ok && hasDash(g.output.reply);
    if (miss || dashOut || !g.ok) { bad++; console.log(`  ✗ ${miss ?? (dashOut ? "dash in shown draft" : "guard rejected")}`); }
    else console.log("  ✓ as expected");
  }
  console.log(`\n${CASES.length - bad}/${CASES.length} as expected · cost $${cost.toFixed(4)}`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
