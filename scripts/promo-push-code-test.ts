// A PROMO CODE BELONGS TO A PUSH, NOT TO A CHANNEL.
//
// Teresa saved a WhatsApp plan with a Thursday push carrying PARMER10 and a Saturday push carrying
// nothing, and both rows came back PARMER10. `match_promotion_push.promo_code` was always per row and
// the route always wrote it per row; the collapse was in the DRAFT MODEL — DraftChannel held one
// `code`, draftToPushes fanned it onto every row of the channel, and codeFor read it back as "the
// first non-empty one on this channel's rows". Two pushes on one channel could not differ.
//
// WHY THIS IS A GUARD AND NOT A BROWSER CHECK. What went wrong is a pure function composed with
// another pure function, and it is invisible in the DOM: the editor showed one code field and the
// table held the right number of columns, so nothing on screen and nothing in the schema was wrong.
// draftFromPlan → draftToPushes is the whole defect surface, so that is what is asserted, on values.
//
// THE LAST BLOCK READS PRODUCTION, READ-ONLY, and is the control that matters most: a load-and-save
// with NO EDITS must return every existing row's code unchanged. Nine live (match, channel) groups
// hold more than one push, and those nine are the only rows in the estate where a fan-out and a
// per-row write could disagree. It asserts the round trip on the real rows without writing one.
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/promo-push-code-test.ts
process.loadEnvFile(".env.local");
import { readFileSync } from "node:fs";
import {
  draftFromPlan, draftToPushes, draftSummary, matchCodes, codeAlsoOnChannels, listChannels,
  type PromoPlan, type PromoPush, type ChannelKey,
} from "../src/lib/matchPromotion";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const ok = (name: string, cond: boolean, d = "") => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} — ${d}`)); };

let seq = 0;
const push = (o: Partial<PromoPush>): PromoPush => ({
  id: ++seq, matchApiId: 17516, channel: "wa", pushAt: null, topic: null,
  promoCode: null, pushedAt: null, pushedBy: null, ...o,
});
const plan = (pushes: PromoPush[]): PromoPlan => ({
  matchApiId: 17516, pushes, comment: null, updatedBy: null, updatedAt: null,
} as PromoPlan);

console.log("TWO PUSHES ON ONE CHANNEL, TWO DIFFERENT CODES:");
{
  const p = plan([
    push({ channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", topic: "Thu", promoCode: "PARMER10" }),
    push({ channel: "wa", pushAt: "2026-09-26T17:00:00.000Z", topic: "Sat", promoCode: "WESTLAKE5" }),
  ]);
  const d = draftFromPlan(p);
  eq("the draft carries a code per ROW", d.wa.rows.map((r) => r.code), ["PARMER10", "WESTLAKE5"]);
  // THE PRE-FIX BEHAVIOUR, NAMED. codeFor returned the first non-empty and draftToPushes fanned it,
  // so this line used to read ["PARMER10", "PARMER10"] — the second code silently destroyed on save.
  eq("and a save with no edits returns BOTH, not the first twice",
     draftToPushes(d).map((x) => x.promoCode), ["PARMER10", "WESTLAKE5"]);
  ok("CONTROL: which is the point — they differ", draftToPushes(d)[0].promoCode !== draftToPushes(d)[1].promoCode);
}

console.log("BLANK IS A REAL ANSWER, PER PUSH:");
{
  const p = plan([
    push({ channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" }),
    push({ channel: "wa", pushAt: "2026-09-26T17:00:00.000Z", promoCode: null }),
  ]);
  const d = draftFromPlan(p);
  eq("a push with no code reads blank, not its neighbour's", d.wa.rows.map((r) => r.code), ["PARMER10", ""]);
  eq("and saves blank", draftToPushes(d).map((x) => x.promoCode), ["PARMER10", ""]);
  // A CODE TYPED ONTO ONE ROW STAYS ON THAT ROW. The mutation the fan-out could not express.
  d.wa.rows[1].code = "WESTLAKE5";
  eq("MUTATION — a code typed on the second push lands on the second push only",
     draftToPushes(d).map((x) => x.promoCode), ["PARMER10", "WESTLAKE5"]);
  ok("CONTROL: and the first row is untouched", draftToPushes(d)[0].promoCode === "PARMER10");
}

console.log("EVERY CHANNEL INDEPENDENTLY:");
{
  const p = plan([
    push({ channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", promoCode: "WA1" }),
    push({ channel: "klaviyo_sms", pushAt: "2026-09-24T17:00:00.000Z", promoCode: "SMS1" }),
    push({ channel: "klaviyo_sms", pushAt: "2026-09-25T17:00:00.000Z", promoCode: null }),
  ]);
  const out = draftToPushes(draftFromPlan(p));
  eq("codes stay with their own channel and row",
     out.map((x) => [x.channel, x.promoCode]), [["wa", "WA1"], ["klaviyo_sms", "SMS1"], ["klaviyo_sms", ""]]);
  // THE FOOTER COUNTS PUSHES WITH A CODE, not channels with one. Two of the three rows carry one.
  eq("the footer counts codes per PUSH", draftSummary(draftFromPlan(p)).codes, 2);
}

console.log("THE TILE'S CODE CHIP, NOW THAT THERE CAN BE MORE THAN ONE:");
{
  eq("one code, one chip", matchCodes(plan([push({ pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" })])), ["PARMER10"]);
  eq("two different codes, both reported, in push order",
     matchCodes(plan([
       push({ pushAt: "2026-09-26T17:00:00.000Z", promoCode: "WESTLAKE5" }),
       push({ pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" }),
     ])), ["PARMER10", "WESTLAKE5"]);
  // CASE AND WHITESPACE ARE NOT A SECOND CODE. Production holds 486 mixed-case codes already.
  eq("the same code twice, spelled differently, is ONE chip", matchCodes(plan([
    push({ pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" }),
    push({ pushAt: "2026-09-26T17:00:00.000Z", promoCode: "parmer10 " }),
  ])), ["PARMER10"]);
  ok("CONTROL: two genuinely different codes are still two", matchCodes(plan([
    push({ pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" }),
    push({ pushAt: "2026-09-26T17:00:00.000Z", promoCode: "WESTLAKE5" }),
  ])).length === 2);
  eq("CONTROL: no code anywhere is an empty list, not a blank chip",
     matchCodes(plan([push({ pushAt: "2026-09-24T17:00:00.000Z" })])), []);
}

/* ── THE REAL ROWS. READ-ONLY, AND NOTHING IS WRITTEN. ────────────────────────────────────────
 * Every (match, channel) group holding more than one push is run through draftFromPlan →
 * draftToPushes — a load and a save with no edits — and its codes compared to what the table holds.
 * Those groups are the only place a fan-out and a per-row write could ever have disagreed, so if
 * this round trip is lossless on them it is lossless on the estate.
 *
 * NO MIGRATION WAS NEEDED and none was run: because saving fanned the channel's code onto every
 * row, every multi-push group already holds ONE code repeated, which is exactly what the per-row
 * read now returns. The backfill happened continuously, as a side effect of the bug.
 *
 * A COUNT OF ZERO IS A FAILURE HERE, not a pass. An empty read, a renamed column and a revoked key
 * all produce "nothing to check", and "nothing to check" is the answer this block hopes for. */
/* ── ONE CODE ACROSS CHANNELS IS ALLOWED, AND THE EDITOR SAYS SO ─────────────────────────────
 * The save route refused it: the same code on two channels of one match returned 400 and wrote
 * nothing. Teresa runs one campaign code across WhatsApp and SMS on purpose, and the refusal made
 * that plan unsaveable to protect a per-channel report nobody had asked for. It was not enforcing a
 * real invariant either — there is no constraint on the table, and production already holds three
 * (match, code) pairs spanning two channels. A note replaces it. */
console.log("A CODE SHARED ACROSS CHANNELS IS A NOTE, NOT A BLOCK:");
{
  const draft = draftFromPlan(plan([
    push({ channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" }),
    push({ channel: "klaviyo_sms", pushAt: "2026-09-24T18:00:00.000Z", promoCode: "PARMER10" }),
    push({ channel: "dm", pushAt: "2026-09-24T19:00:00.000Z", promoCode: "OTHER5" }),
  ]));
  // THE SAVE CARRIES BOTH. This is the shape the route used to reject outright.
  eq("both channels keep the shared code through a save",
     draftToPushes(draft).map((x) => [x.channel, x.promoCode]),
     [["wa", "PARMER10"], ["dm", "OTHER5"], ["klaviyo_sms", "PARMER10"]]);

  eq("WhatsApp's note names the other channel", codeAlsoOnChannels(draft, "wa", "PARMER10"), ["Klaviyo SMS"]);
  eq("...and SMS's note names WhatsApp — it appears on BOTH", codeAlsoOnChannels(draft, "klaviyo_sms", "PARMER10"), ["WhatsApp"]);
  // PRESENCE CONTROL: a code on ONE channel only produces no note at all.
  eq("CONTROL: a code used on one channel only has no note", codeAlsoOnChannels(draft, "dm", "OTHER5"), []);
  eq("CONTROL: a blank code has no note", codeAlsoOnChannels(draft, "wa", ""), []);
  // THE SAME CHANNEL TWICE IS NOT A SHARED CODE — that is one campaign sent twice.
  const twice = draftFromPlan(plan([
    push({ channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" }),
    push({ channel: "wa", pushAt: "2026-09-26T17:00:00.000Z", promoCode: "PARMER10" }),
  ]));
  eq("two pushes on ONE channel sharing a code is not a cross-channel note",
     codeAlsoOnChannels(twice, "wa", "PARMER10"), []);
  // NORMALISED, so the note cannot disagree with what the save is about to write.
  const cased = draftFromPlan(plan([
    push({ channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" }),
    push({ channel: "klaviyo_sms", pushAt: "2026-09-24T18:00:00.000Z", promoCode: " parmer10 " }),
  ]));
  eq("a differently-spelled same code still raises the note", codeAlsoOnChannels(cased, "wa", "PARMER10"), ["Klaviyo SMS"]);
  // AN OFF CHANNEL IS NOT CONSULTED: its rows are not going to be written.
  const off = draftFromPlan(plan([push({ channel: "wa", pushAt: "2026-09-24T17:00:00.000Z", promoCode: "PARMER10" })]));
  off.klaviyo_sms = { on: false, rows: [{ key: "x", pushAt: null, topic: "", code: "PARMER10" }] };
  eq("an OFF channel raises no note", codeAlsoOnChannels(off, "wa", "PARMER10"), []);
  off.klaviyo_sms.on = true;
  eq("CONTROL: turning it on raises one", codeAlsoOnChannels(off, "wa", "PARMER10"), ["Klaviyo SMS"]);

  eq("one other channel reads as a name", listChannels(["Klaviyo SMS"]), "Klaviyo SMS");
  eq("two read as a pair", listChannels(["Klaviyo SMS", "DM"]), "Klaviyo SMS and DM");
  eq("three read as a list", listChannels(["Klaviyo SMS", "DM", "Facebook"]), "Klaviyo SMS, DM and Facebook");

  /* THE ROUTE'S REFUSAL IS GONE. A SOURCE ASSERTION, because the refusal lived behind an HTTP
   * boundary this gate cannot cross — and a PAIRING, positive and negative, because a positive
   * pattern proves the note exists somewhere and cannot prove the block does not. */
  const route = readFileSync("src/app/api/match-promotion/route.ts", "utf8");
  const live = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("the route no longer refuses a shared code", !/cannot be `?\s*\+?\s*`?attributed to either/.test(live) && !/channels\.size > 1/.test(live),
     "THE BLOCK IS BACK — a shared code is a note now, not a 400");
  ok("CONTROL: that scan fires on the refusal it is looking for",
     /channels\.size > 1/.test("for (const [code, channels] of byCode) { if (channels.size > 1) {"));
  ok("and the editor renders the note instead",
     /data-testid="code-shared"/.test(readFileSync("src/components/PushPlanEditor.tsx", "utf8")),
     "nothing tells the operator the codes are shared");
}

async function productionRows() {
  console.log("PRODUCTION ROWS — a load and a save with no edits changes nothing:");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail++; console.log("  ✗ no Supabase credentials in the environment — the control could not run");
  } else {
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await sb.from("match_promotion_push")
      .select("id,match_api_id,channel,push_at,topic,promo_code").eq("scope", "match");
    if (error) { fail++; console.log(`  ✗ the read failed: ${error.message}`); }
    else {
      const rows = data ?? [];
      ok(`read ${rows.length} match-scoped push rows`, rows.length > 0, "the table came back empty");
      const byMatch = new Map<number, PromoPush[]>();
      for (const r of rows) {
        const key2 = Number(r.match_api_id);
        const list = byMatch.get(key2) ?? byMatch.set(key2, []).get(key2)!;
        list.push(push({
          id: Number(r.id), matchApiId: key2, channel: String(r.channel) as ChannelKey,
          pushAt: (r.push_at as string | null) ?? null, topic: (r.topic as string | null) ?? null,
          promoCode: (r.promo_code as string | null) ?? null,
        }));
      }
      /* THE GROUPS THAT MAKE THIS QUESTION MEANINGFUL: more than one push on one channel of one
       * match. A group of one cannot distinguish a fan-out from a per-row write. */
      let multi = 0, withCode = 0, lossy = 0;
      const lost: string[] = [];
      for (const [matchId, pushes] of byMatch) {
        const chans = new Set(pushes.map((p) => p.channel));
        for (const ch of chans) if (pushes.filter((p) => p.channel === ch).length > 1) multi++;
        const before = new Map(pushes.map((p) => [p.id, (p.promoCode ?? "").trim()]));
        withCode += [...before.values()].filter(Boolean).length;
        /* THE ROUND TRIP. draftToPushes drops an OFF channel, and draftFromPlan turns a channel on
         * exactly when it has rows, so every row of every real plan survives it. */
        for (const out of draftToPushes(draftFromPlan(plan(pushes)))) {
          if (out.id == null) continue;
          const was = before.get(out.id);
          if (was !== (out.promoCode ?? "").trim()) {
            lossy++; if (lost.length < 6) lost.push(`match ${matchId} push ${out.id}: ${JSON.stringify(was)} -> ${JSON.stringify(out.promoCode)}`);
          }
        }
      }
      console.log(`    ${byMatch.size} matches · ${multi} (match, channel) groups hold more than one push · ${withCode} rows carry a code`);
      ok("there ARE multi-push groups to check — an empty set would pass this vacuously", multi > 0, `multi=${multi}`);
      ok("there ARE codes to lose — a table with no codes cannot fail the next line", withCode > 0, `withCode=${withCode}`);
      eq("every real row's code survives a load and a save with no edits", { lossy, lost }, { lossy: 0, lost: [] });
    }
  }
}

productionRows()
  .catch((e) => { fail++; console.log(`  \u2717 the production control threw: ${e instanceof Error ? e.message : String(e)}`); })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    // A SUITE REPORTING ZERO ASSERTIONS IS FAILING, NOT PASSING.
    if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
    process.exit(fail === 0 ? 0 : 1);
  });
