/* THE ROSTER PANEL — three kinds of player, the email, and a text to SOME of them.
 *
 * THE NUMBER ON THE BUTTON IS PHONES, NEVER ROWS. One person holding two spots is one text, and a
 * confirm that says "18" when it means 17 is a confirm nobody can act on. Half these assertions
 * exist to keep that true.
 *
 * AND THE LIST NARROWS, NEVER WIDENS. A subset send filters a server-resolved recipient set; an id
 * that is not on the match matches no row. The route assertions below pin that shape, because the
 * failure mode is a text to somebody who was never in the match.
 */

import { readFileSync } from "node:fs";
import {
  playerKinds, teamMemberCount, textsForSelection, moneyKinds, sumMoney, teamMoney, rosterCounts, usd,
  type EditRow,
} from "../src/lib/rosterEditModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));

const r = (umId: number, team: number, spot: number | null, playerId: number, o: Partial<EditRow> = {}): EditRow =>
  ({ umId, team, playerNumber: spot, name: `P${playerId}`, phone: `+1512555${String(1000 + playerId)}`,
     fake: false, playerId, member: false, email: `p${playerId}@example.com`,
     paid: 0, charged: 0, credit: 0, paidStatus: null, ...o });

console.log("\nmember, daily, guest — and guest is derived from THIS roster");
{
  /* Match 18281's real shape: isra holds two spots on one booking. */
  const roster = [
    r(1, 1, 1, 101, { member: true }),
    r(2, 1, 2, 102),
    r(3, 1, 3, 103, { member: true }),
    r(4, 2, 1, 104),
    r(5, 2, 2, 105),          // isra, first spot
    r(6, 2, 3, 105),          // isra, the additional spot — SAME playerId
    r(7, 2, 4, 106, { fake: true, phone: null, email: "fake+7@matchday.com" }),
  ];
  const k = playerKinds(roster);
  is("a player with an active subscription is a Member", k.get(1), "member");
  is("a player without one is Daily", k.get(2), "daily");
  is("THE SECOND ROW FOR THE SAME PERSON IS THE GUEST", k.get(6), "guest");
  is("…and the first one is not", k.get(5), "daily");
  is("a fake row has no kind at all — it is padding, not a person", k.has(7), false);
  is("exactly one guest on this roster", [...k.values()].filter((x) => x === "guest").length, 1);

  /* GUEST IS THE ROW THE PANEL DRAWS SECOND, not whichever the API returned first. Reversing the
   * input must not move the badge. */
  const reversed = playerKinds([...roster].reverse());
  is("the badge does not move when the API returns the rows in another order", reversed.get(6), "guest");
  is("…and the first spot still reads Daily", reversed.get(5), "daily");

  /* A MEMBER WHO BOOKED TWICE: the second row is still the guest. */
  const memberTwice = playerKinds([r(10, 1, 1, 200, { member: true }), r(11, 1, 2, 200, { member: true })]);
  is("a member's additional spot reads Guest", [memberTwice.get(10), memberTwice.get(11)], ["member", "guest"]);

  is("each team counts its own members", [1, 2].map((t) => teamMemberCount(roster, t)), [2, 0]);
  /* THE CONTROL: the count is per team, not the roster's total. */
  is("control: the roster holds 2 members in total, both on team 1",
    [...k.values()].filter((x) => x === "member").length, 2);
}

console.log("\nthe number is phones, never rows");
{
  const roster = [
    r(1, 1, 1, 101),
    r(2, 1, 2, 102),
    r(3, 1, 3, 105),
    r(4, 1, 4, 105),                                   // same person, same phone
    r(5, 1, 5, 106, { phone: null }),                  // no phone on file
    r(6, 1, 6, 107, { fake: true, phone: null }),      // a fake
  ];
  const all = new Set([1, 2, 3, 4, 5, 6]);
  const t = textsForSelection(roster, all);
  is("six rows picked, but five people and one of them has no phone", [t.rows, t.texts, t.noPhone], [5, 3, 1]);
  is("TWO ROWS ON ONE PHONE IS ONE TEXT", textsForSelection(roster, new Set([3, 4])).texts, 1);
  is("…and it still says two rows, so the difference can be explained", textsForSelection(roster, new Set([3, 4])).rows, 2);
  is("two unrelated players are two texts", textsForSelection(roster, new Set([1, 2])).texts, 2);
  is("a fake cannot be texted and is not counted", textsForSelection(roster, new Set([6])), { texts: 0, rows: 0, noPhone: 0 });
  is("nothing picked is nothing to send", textsForSelection(roster, new Set()).texts, 0);
  /* FORMATTING MUST NOT SPLIT ONE PERSON IN TWO. The same number written two ways is one phone. */
  const formatted = [r(20, 1, 1, 300, { phone: "+15125551000" }), r(21, 1, 2, 301, { phone: "(512) 555-1000" })];
  is("the same number written two ways is still one text", textsForSelection(formatted, new Set([20, 21])).texts, 1);
}

console.log("\nthe money belongs to the row, and every row's own amount is safe to add up");
{
  /* MATCH 18281, user 89343 — two spots, ONE charge. The API puts the whole 24.00 on the first row
   * and 0 on the second, so the second says "on the booking" rather than $0.00. */
  SEQ = 0;
  const oneCharge = [r(1, 1, 1, 500, { paid: 24, charged: 25.98 }), r(2, 1, 2, 500, { paidStatus: "PAID" })];
  const k1 = moneyKinds(oneCharge);
  is("the booking row carries the money", k1.get(1), "paid");
  is("…and the spot it paid for says so instead of reading $0.00", k1.get(2), "on-booking");
  is("the pair adds up to the one charge, not twice it", sumMoney(oneCharge).booked, 24);

  /* MATCH 18343, user 74713 — FOUR rows and THREE payment intents: 24.00 + 0 + 12.00 + 12.00. They
   * came back and booked again. This is the case that kills "a repeated user is already paid for":
   * dropping every repeat reports 24.00 when 48.00 was taken. */
  SEQ = 0;
  const cameBack = [
    r(10, 2, 6, 600, { paid: 24, charged: 25.98 }),
    r(11, 2, 3, 600, { paidStatus: "PAID" }),
    r(12, 2, 5, 600, { paid: 12, charged: 12.99 }),
    r(13, 2, 8, 600, { paid: 12, charged: 12.99 }),
  ];
  const k2 = moneyKinds(cameBack);
  is("only the zero row is on the booking", [k2.get(10), k2.get(11), k2.get(12), k2.get(13)],
    ["paid", "on-booking", "paid", "paid"]);
  is("ALL FOUR ROWS ADD UP — 48.00, which is what was charged", sumMoney(cameBack).booked, 48);
  /* THE CONTROL: what dropping every repeat would have reported. */
  const firstOnly = cameBack.filter((x, i) => i === 0);
  is("control: keeping only the first row would have reported 24.00", sumMoney(firstOnly).booked, 24);

  /* A COMPED ROW IS NOT A SHARED ONE. Both are zero; only one of them rode in on somebody's card. */
  SEQ = 0;
  const comped = [r(20, 1, 1, 700, { paidStatus: "FREE" }), r(21, 1, 2, 701, { paid: 12 })];
  is("a member playing free reads free, not 'on the booking'", moneyKinds(comped).get(20), "free");
  is("a fake row is neither", moneyKinds([r(30, 1, 1, 800, { fake: true })]).get(30), "fake");

  /* NOTHING IS DERIVED. Production row 310694 on match 19104 is paid 8.00, credit 0.66, charged
   * 7.95 — 8.00 minus 0.66 is not 7.95, because the card fee is inside `charged` and not inside
   * `paid`. Each figure is a sum of its own column and the panel says they will not reconcile. */
  const odd = [r(40, 1, 1, 900, { paid: 8, credit: 0.66, charged: 7.95 })];
  const sum = sumMoney(odd);
  is("all three are carried as they came", [sum.booked, sum.credit, sum.charged], [8, 0.66, 7.95]);
  is("…and booked minus credit is NOT charged, which is why neither is computed from the other",
    Math.abs((sum.booked - sum.credit) - sum.charged) > 0.001, true);

  SEQ = 0;
  const twoTeams = [r(50, 1, 1, 1000, { paid: 12 }), r(51, 1, 2, 1001, { paid: 12 }), r(52, 2, 1, 1002, { paid: 15 })];
  is("a team total is its own rows", [teamMoney(twoTeams, 1).booked, teamMoney(twoTeams, 2).booked], [24, 15]);
  is("…and the teams add to the match", teamMoney(twoTeams, 1).booked + teamMoney(twoTeams, 2).booked, sumMoney(twoTeams).booked);
  /* Every value reaching this came from Math.round(cents)/100, so it is already exact to the cent
   * — a half-cent input like 285.775 is not a case that can occur and is not asserted here. */
  is("money formats to the cent", [usd(0), usd(12), usd(0.66), usd(285.78)], ["$0.00", "$12.00", "$0.66", "$285.78"]);
}

console.log("\nwhat the roster is made of, counted in spots");
{
  SEQ = 0;
  const roster = [
    r(1, 1, 1, 101, { member: true }), r(2, 1, 2, 102), r(3, 1, 3, 103, { member: true }),
    r(4, 2, 1, 104), r(5, 2, 2, 105), r(6, 2, 3, 105),           // 105 holds two spots
    r(7, 2, 4, 106, { fake: true, phone: null }),
  ];
  const c = rosterCounts(roster);
  // 101 and 103 are members; 102, 104 and the FIRST 105 are daily; the second 105 is the guest.
  is("members, daily and guests", [c.members, c.daily, c.guests], [2, 3, 1]);
  is("…and they add to the real spots", c.members + c.daily + c.guests, c.real);
  is("a fake holds a spot but is none of the three", [c.fake, c.real], [1, 6]);
  is("…so the three counts and the fakes account for every row", c.real + c.fake, roster.length);

  /* SPOTS, NOT PEOPLE. The same roster produces 5 spots and 4 phones, and the two lines that show
   * those numbers sit inches apart — so each must say which it is counting. */
  is("the person with two spots is counted twice", c.real, 6);
  is("…while the text count for the same rows is people — five phones, not six spots",
    textsForSelection(roster, new Set([1, 2, 3, 4, 5, 6, 7])).texts, 5);

  SEQ = 0;
  is("an all-fake roster counts nothing real",
    rosterCounts([r(10, 1, 1, 200, { fake: true }), r(11, 1, 2, 201, { fake: true })]).real, 0);
  is("an empty roster is all zeroes", rosterCounts([]), { members: 0, daily: 0, guests: 0, real: 0, fake: 0 });
}

console.log("\nthe route carries the money it was already receiving");
{
  const src = readFileSync("src/app/api/matchday/[env]/roster/[matchId]/route.ts", "utf8");
  for (const f of ["amount", "totalAmount", "creditAmount", "paidStatus"]) {
    yes(`the Row type now lists ${f}`, new RegExp(`${f}\\??:`).test(src), f);
  }
  yes("cents become dollars in exactly one helper", /const dollars = \(v: unknown\) => Math\.round/.test(src));
  is("…used for all three figures and nothing else", (src.match(/dollars\(p\./g) ?? []).length, 3);
  /* centsToDollars RETURNS A STRING. Using it here would have made the panel add "12.00" + "8.00"
   * into "12.008.00" — the totals would have looked like a formatting bug rather than a money one. */
  yes("the string formatter is NOT called here — only named in the comment saying why",
    !/centsToDollars\(/.test(src));
  yes("no figure is computed from the others", !/paid\s*-\s*credit|booked\s*-\s*credit|amount\s*-\s*creditAmount/.test(src));
  /* NO NEW REQUEST. The money arrives on the roster call this route already makes; the endpoints
   * it talks to are the same four as before (the last two are the POST handler's read-backs). */
  const endpoints = [...new Set([...src.matchAll(/apiGet<[^(]*\(\s*env,\s*`([^`]+)`/g)].map((m) => m[1]))];
  is("the endpoints this route calls are unchanged", endpoints.sort(), [
    "/admin/matches/${M}", "/admin/matches/${M}/players",
    "/admin/matches/${matchId}", "/admin/matches/${matchId}/players",
    "/admin/players",                                  // the search-to-add dropdown, unrelated
    "/admin/promocodes/${pid}",
  ].sort());
  yes(`control: ${endpoints.length} endpoints were actually read out of the source`, endpoints.length === 6);
}

console.log("\nthe recipient resolver: the list narrows and cannot widen");
{
  const src = readFileSync("src/lib/matchNotifyRecipients.ts", "utf8");
  /* EVERY EXISTING FILTER SURVIVES. The narrowing is an extra filter on top of these, never a
   * replacement for them — that is what stops a list reaching a cancelled or fake row. */
  for (const filter of [
    `.eq("user_type", "PLAYER")`, `.is("deleted_at", null)`, `.is("canceled_at", null)`,
    "is_cancelled.is.null,is_cancelled.eq.false", "is_absent.is.null,is_absent.eq.false",
    "paid_status.is.null,paid_status.neq.WAITING",
  ]) yes(`the ${filter.slice(0, 34)} filter is still there`, src.includes(filter), filter);
  yes("fakes are still dropped", /isFakePlayerRow\(r\)\) continue/.test(src));
  yes("the E.164 dedupe is still there", /byPhone/.test(src) && /normalizePhone/.test(src));

  const iFake = src.indexOf("isFakePlayerRow(r)) continue");
  const iNarrow = src.indexOf("if (wanted != null && !wanted.has");
  const iDedupe = src.indexOf("if (!byPhone.has(e164))");
  yes("the narrowing runs AFTER the row filters", iFake > 0 && iNarrow > iFake, `${iFake}/${iNarrow}`);
  /* BEFORE THE DEDUPE, ON PURPOSE. Two people can share a phone; the dedupe keeps the first
   * user_id for it, so narrowing afterwards would find nothing for the second one and silently
   * text nobody. */
  yes("…and BEFORE the phone dedupe", iNarrow < iDedupe, `${iNarrow}/${iDedupe}`);
  yes("an id that is not on the match is recorded as ignored, never looked up",
    /ignoredUserIds/.test(src) && !/\.eq\("user_id"/.test(src));
  yes("null still means the whole match", /userIds: number\[\] \| null = null/.test(src));
}

console.log("\nthe send route");
{
  const src = readFileSync("src/app/api/match-chats/[chatId]/notify/route.ts", "utf8");
  yes("it takes an optional list of player ids", /user_ids\?: unknown/.test(src));
  yes("…and passes it to the resolver, which does the narrowing server-side",
    /resolveMatchNotifyRecipients\(supabase, matchApiId, narrowIds\)/.test(src));
  /* A MALFORMED LIST IS A REFUSAL. Treating it as "no list" would turn a four-person send into a
   * whole-match send on a typo. */
  yes("a malformed list is refused rather than treated as everyone", /user_ids must be an array/.test(src));
  yes("…and so is one holding no usable id", /held no usable id/.test(src));

  for (const guard of ["NOTIFY_TEMPLATE_IDS.includes", "Message is empty", "MAX_BODY_LEN", "unfilledTokens", "Telnyx is not configured", "assertMatchInScope"]) {
    yes(`the ${guard} guard is unchanged`, src.includes(guard), guard);
  }
  yes("the city boundary is still checked on the chat id, on BOTH verbs",
    (src.match(/assertMatchInScope/g) ?? []).length >= 2);

  yes("the log records whether this was everyone or a subset", /audience: "subset"/.test(src) && /audience: "match"/.test(src));
  yes("…and what was actually asked for", /requested_user_ids: narrowIds/.test(src));
  /* THE SEND NEVER RETRIES. The one retry in this file is the AUDIT insert falling back when
   * migration 0160 has not been applied — a text that already reached a phone must still be
   * logged. These two assertions together say the retry is on the log and not on Telnyx. */
  /* THE AUDIT SHAPE. Migration 0160 is applied, so the fallback is dormant — but it stays, because
   * a rollback that took the columns away must not lose the row for a text that already reached a
   * phone. These pin that it is the ONLY insert that writes the old shape, and that it can only be
   * reached by a column error. */
  const inserts = [...src.matchAll(/\.from\("match_notify_log"\)\.insert\(([^)]*)\)/g)].map((m) => m[1].trim());
  is("there are exactly two audit inserts in the file", inserts.length, 2);
  yes("the first writes the audience and what was asked for", /\.\.\.subsetCols/.test(inserts[0]), inserts[0]);
  yes("the second — the fallback — is the only one that does not", inserts[1] === "auditRow", inserts[1]);
  yes("…and it runs only when the column itself is missing",
    /if \(logInsert\.error && \/audience\|requested_user_ids\|column\/i\.test\(logInsert\.error\.message\)\)/.test(src));
  yes("the audit insert can fall back when 0160 is not yet applied", /migration 0160 is not applied/.test(src));
  /* BOTH PATHS NAME THEIR AUDIENCE. A whole-match send is not "the absence of a subset" in the
   * log — it says 'match' and carries a null list, so a reader never has to infer. */
  yes("a whole-match send records audience 'match' with a null list explicitly",
    /\{ audience: "match", requested_user_ids: null \}/.test(src));
  is("…and there is exactly one Telnyx send call in the file", (src.match(/telnyx\.messages\.send/g) ?? []).length, 1);
  yes("…inside a single allSettled over the recipients, with no loop around it",
    /Promise\.allSettled\(\s*recipients\.map/.test(src) && !/while\s*\(/.test(src));

  /* THE TEMPLATE ID STAYS REQUIRED. It is what makes the log answerable later. */
  yes("an unknown template is still refused", /Unknown template/.test(src));
}

console.log("\nthe panel");
{
  const v = readFileSync("src/components/MatchPanel.tsx", "utf8");
  yes("every row can be picked, except a fake", /mp-pick-\$\{p\.umId\}/.test(v) && /p\.fake\s*\n?\s*\?\s*<span className="mp-ckhole"/.test(v));
  yes("a fake row offers no Copy email", /!p\.fake && \(p as PlayerRow\)\.email/.test(v));
  yes("the address travels in the title and the aria-label says what the glyph does",
    /title=\{\(p as PlayerRow\)\.email/.test(v) && /aria-label=\{`Copy email for/.test(v));
  yes("the kind sits in its own column", /className="mp-pkind"/.test(v));
  yes("…and the three kinds are drawn three ways", /mp-kmember/.test(v) && /mp-kdaily/.test(v) && /mp-kguest/.test(v));
  yes("selection is blue and membership is green",
    /mp-ck:checked\)\{background:#eef4fd/.test(v) && /\.mp-kmember\{display:inline-block;background:#1f7a4d/.test(v));
  yes("the guest mark is on the name's own line, not a second line", /mp-sharedot/.test(v) && !/mp-guestline/.test(v));
  yes("the team header carries its own member count", /teamMemberCount\(origin\.rows, t\.teamNumber\)/.test(v));

  /* THE BUTTONS NAME TEXTS. Never rows — the whole point of counting phones. */
  yes("the review button counts texts", /Review \{tally\.texts\} text/.test(v));
  yes("the send button counts texts", /Send \$\{tally\.texts\} text/.test(v));
  yes("…and the bar states the row count beside it, so the difference is visible",
    /\{tally\.rows\} row\{tally\.rows === 1 \? "" : "s"\} selected/.test(v));
  yes("the reason they differ is on screen", /share a phone with somebody else you picked/.test(v));

  yes("the confirm shows the exact words", /data-testid="mp-sms-exact"/.test(v));
  yes("…and says it cannot be recalled", /cannot be recalled/.test(v));
  yes("…and there is no send that skips it", !/onClick=\{\(\) => void sendText\(\)\}[\s\S]{0,80}mp-sms-review/.test(v)
    && (v.match(/void sendText\(\)/g) ?? []).length === 1);

  /* NO WHOLE-MATCH SHORTCUT HERE. Match Chats already has one; this panel is deliberately the
   * other thing, and a select-all button is a text-everyone button with an extra click. */
  yes("no select-all on this panel", !/mp-sel-all|Select all|selectAll/.test(v));
  yes("no text-everyone shortcut", !/Text everyone|notify everyone/i.test(v));
  yes("no saved recipient groups", !/recipientGroup|savedGroup/i.test(v));

  /* THE MONEY COLUMN. */
  yes("every row has a money cell", /data-testid=\{`mp-money-\$\{p\.umId\}`\}/.test(v));
  yes("…and it is never blank: a fake says a dash, a shared spot says so, everyone else gets a figure",
    /mp-mnone/.test(v) && /on the booking/.test(v) && /usd\(\(p as PlayerRow\)\.paid/.test(v));
  yes("the credit is a second line, shown only when there is credit", /\(\(p as PlayerRow\)\.credit \?\? 0\) > 0/.test(v));
  yes("the team header carries its own total", /teamMoney\(origin\.rows, t\.teamNumber\)/.test(v));
  yes("the match line names all three sums", /mp-money-booked/.test(v) && /mp-money-charged/.test(v) && /mp-money-credit/.test(v));
  /* The explainer that used to say this was deleted on request. The hidden rows still have their
   * own line higher up the panel (mp-hidden-count), so nothing about them was lost with it. */
  yes("the hidden rows are still declared, on their own line", /data-testid="mp-roster-hidden"/.test(v) && /They hold no spot/.test(v));
  yes("the money column is right-aligned and tabular", /\.mp-pmoney\{display:flex;flex-direction:column;align-items:flex-end/.test(v));
  yes("…and on a phone it takes its own line with the credit beside the amount",
    /grid-template-areas:"ck spot name" "\. money money" "\. kind acts"/.test(v) && /\.mp-pmoney\{grid-area:money;flex-direction:row/.test(v));
  /* ── THE ROW MUST FIT ITS CARD, AND THE NAME MUST SURVIVE ────────────────────────────────
   * Measured in the Gameday Ops drawer at 760px: the fixed tracks plus the actions came to 341px
   * of content in a 322px row, so the only flexible track resolved to ZERO and the name rendered
   * at 0 x 0 on all 32 rows of match 18969 — present in the DOM, correct text, invisible. */
  yes("the name is the only flexible track", /grid-template-columns:20px 20px minmax\(60px,1fr\) 62px 74px auto/.test(v));
  yes("…with a floor, so it can never resolve to zero again", /minmax\(60px,1fr\)/.test(v));
  yes("…and it truncates rather than pushing the row wider", /\.mp-pname\{[^}]*text-overflow:ellipsis/.test(v));
  yes("Move is an icon carrying its own label", /data-testid=\{`mp-move-\$\{p\.umId\}`\} className="mp-icon"/.test(v)
    && /aria-label=\{`Move \$\{p\.name\} to another team or spot`\}/.test(v));
  yes("…and a tooltip that says the same thing", /title=\{`Move \$\{p\.name\} to another team or spot`\}/.test(v));

  /* THE TEAM GRID STAYS TWO-UP because players move between teams and both have to be on screen —
   * and it stacks on ITS OWN width, not the window's. A viewport media query is how the roster
   * ended up two-up inside a 346px card in the first place. */
  yes("the teams are two columns", /\.mp-teamgrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(v));
  yes("…and stack on a CONTAINER query, not a viewport one",
    /container-type:inline-size;container-name:mproster/.test(v)
    && /@container mproster \(max-width:980px\)\{ \.mp-teamgrid\{grid-template-columns:1fr\} \}/.test(v));

  /* ── THE TWO EXPLAINERS ARE GONE ────────────────────────────────────────────────────────── */
  yes("the money line no longer explains itself", !/Booked is the spot price before the fee/.test(v));
  yes("…and the icon key is gone", !/copy email &middot;.*remove from the match/.test(v));
  /* THE MEMBERSHIP-READ FAILURE WAS LIVING INSIDE THE ICON KEY and is not an explainer: without it
   * every row quietly reads Daily when the query failed. It keeps its own line. */
  yes("the membership-read failure survived on its own line", /roster\.membershipError && \(/.test(v)
    && /membership could not be read/.test(v));

  /* THE COUNTS LINE. */
  yes("it names all four counts", /mp-count-promo/.test(v) && /mp-count-members/.test(v)
    && /mp-count-daily/.test(v) && /mp-count-guests/.test(v));
  yes("…the promo figure is the same one the promo line reads", /data-promo=\{roster\.promo\?\.spots \?\? 0\}/.test(v)
    && /<b data-testid="mp-count-promo">\{roster\.promo\?\.spots \?\? 0\}/.test(v));
  yes("…it says 'daily', matching the badge on the rows", /<\/b> daily/.test(v) && !/\bDPP\b/.test(v));
  yes("…and it is counted from the visible rows, which already exclude the hidden ones",
    /rosterCounts\(origin\.rows\)/.test(v));

  /* NO LITERAL ESCAPES IN JSX TEXT. `<b>\u2709</b>` between tags is text, not a string literal, so
   * it rendered the six characters instead of the glyph. Every escape in this file must sit inside
   * quotes or backticks, where it is actually parsed. */
  const bare = v.split("\n").map((line, i) => [i + 1, line] as const).filter(([, line]) => {
    const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/'(?:[^'\\]|\\.)*'/g, "").replace(/`(?:[^`\\]|\\.)*`/g, "");
    return /\\u[0-9a-fA-F]{4}/.test(stripped);
  });
  is("no \\uXXXX escape sits outside a string literal", bare.map(([n]) => n), []);
  yes(`control: ${(v.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length} escapes exist in the file to be checked`,
    (v.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length > 0);

  /* THIS PANEL MUST NOT BECOME A WAY TO MOVE MONEY. */
  /* Narrowly on ACTIONS. "refunded" appears as a read-only count of hidden rows and always did. */
  yes("nothing here charges, refunds or credits",
    !/createRefund|refundPlayer|adjustCredit|createPaymentIntent|method: "POST"[^\n]*(refund|credit)/i.test(v));
}

console.log("\nthe Gameday drawer gives the open match most of the window");
{
  const g = readFileSync("src/components/GamedayBoard.tsx", "utf8");
  yes("the wide panel is 1400, not 760", /const PANEL_W_WIDE = 1400;/.test(g));
  yes("…held to 92vw of the space it actually has, so the board stays visible behind it",
    /width:min\(var\(--panel-w,600px\),calc\(92vw - var\(--panel-right,0px\)\)\)/.test(g));
  yes("…and the panel inside it no longer re-caps the width",
    /\.gdo \.gpanel-body>\.mp>\.mp-panel\{height:100%;max-width:none\}/.test(g));
  /* THE DOCK STILL FITS BESIDE IT. panelW only goes wide when they are NOT coexisting, which is
   * what keeps "panel sits left of the dock, both fit" true at >=1600. */
  yes("the wide width applies only when the chat dock is not beside it",
    /const panelW = wide && !coexist \? PANEL_W_WIDE : PANEL_W;/.test(g));
  const sp = readFileSync("src/components/MatchSidePanel.tsx", "utf8");
  yes("the dock offset travels to the stylesheet", /\["--panel-right" as string\]: `\$\{right\}px`/.test(sp));
}

console.log(`\nroster-panel: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
