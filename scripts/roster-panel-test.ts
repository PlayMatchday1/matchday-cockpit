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
import { playerKinds, teamMemberCount, textsForSelection, type EditRow } from "../src/lib/rosterEditModel";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));

const r = (umId: number, team: number, spot: number | null, playerId: number, o: Partial<EditRow> = {}): EditRow =>
  ({ umId, team, playerNumber: spot, name: `P${playerId}`, phone: `+1512555${String(1000 + playerId)}`,
     fake: false, playerId, member: false, email: `p${playerId}@example.com`, ...o });

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
}

console.log(`\nroster-panel: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
