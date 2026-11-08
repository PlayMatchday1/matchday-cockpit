// GUEST PASSES — what the support agent does when a member asks for theirs (Ryan, 2026-11-08). Pure, so
// scripts/ai-draft-test.ts asserts every branch inside `npm run verify`. The facts are read by
// src/lib/guestPassLoad.ts; this file reads no database, network or clock.
//
// THE RULE. Members get 3 guest passes a year. The pass is the member's personal code: city code +
// member number + "FP" (SATX600FP), PERCENT 100, 3 uses in total (TOTAL_USAGE), live for a year. Friends
// enter it on their own profile while logged in. A new membership does NOT earn new uses: a live code
// under ANY slug this player (or another account on their phone) has held counts.
//
// WHAT COUNTS AS A USE: a standing booking on the code in our mirror, played or upcoming
// (src/lib/promoRedemptions, Ryan's one rule since 2026-10-04; MatchDay's own usageCount is not used).
// The mirror is up to a day behind (/api/sync/cron at 11:00 UTC), so a use made today may not show yet.
//
// The answer never carries the code to the model: the reply holds the {code} placeholder and the server
// fills it in (src/lib/aiDraftRun.ts), so the model can't name a code that isn't this member's.

export const GUEST_PASS_USES = 3;
const DAY_MS = 86400e3;

/** A …FP code in our mirror, with how many of its uses are spent. used null = couldn't be counted. */
export type GuestCodeRow = { api_id: number; code: string; end_date_utc: string | null; deleted_at: string | null; used: number | null };

export type GuestPassFacts = {
  accountConfirmed: boolean;
  /** The live membership as the profile read it. null = no membership row at all. */
  membership: { statusRaw: string | null; price: number | null; canceledAt: string | null; since: string | null } | null;
  /** The live membership's slug (SATX600). */
  slug: string | null;
  /** …FP codes under every slug this player, or another account on their phone, has held. null = the read failed. */
  codes: readonly GuestCodeRow[] | null;
  /** A staff message on the thread says the membership checks out (rule 11, for a membership under 24 hours old). */
  staffConfirmed: boolean;
  now: number;
};

export type GuestPassAnswer =
  | { kind: "ask_phone" }
  | { kind: "not_member" }
  | { kind: "create"; code: string }
  | { kind: "existing"; code: string; usesLeft: number; endsOn: string }
  | { kind: "used_up"; code: string; resetsOn: string }
  | { kind: "person"; reason: string };

export const guestCodeName = (slug: string) => `${slug}FP`;
const SLUG_RX = /^[A-Za-z]+\d+$/;
// Calendar wording for the player, in Central (where the code's end was set).
export const guestDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" });

export function decideGuestPass(f: GuestPassFacts): GuestPassAnswer {
  const person = (reason: string): GuestPassAnswer => ({ kind: "person", reason });
  // Step 1: which account is this? Not known: ask for the phone number on their account (never a screenshot).
  if (!f.accountConfirmed) return { kind: "ask_phone" };
  const m = f.membership;
  const status = (m?.statusRaw ?? "").toUpperCase();
  if (!m || (status !== "ACTIVE" && status !== "ADDED_FROM_ADMIN")) return { kind: "not_member" };
  if (f.codes == null) return person("Guest passes: this member's codes couldn't be checked.");
  // A code they already hold is theirs to be told about, whatever else is true. What follows the live-code
  // check only gates making a NEW one. (Dry run 2026-11-08: two members who had cancelled but were still
  // playing through the month asked; one already held a used-up code from an earlier membership.)

  const live = f.codes.filter((c) => !c.deleted_at && (!c.end_date_utc || Date.parse(c.end_date_utc) > f.now));
  if (live.length > 1) return person(`Guest passes: ${live.length} live codes on this player (${live.map((c) => c.code).join(", ")}).`);
  if (live.length === 1) {
    const c = live[0];
    if (c.used == null) return person(`Guest passes: the uses on ${c.code} couldn't be counted.`);
    const left = GUEST_PASS_USES - c.used;
    const ends = c.end_date_utc ? guestDay(c.end_date_utc) : null;
    if (left <= 0) return ends ? { kind: "used_up", code: c.code, resetsOn: ends } : person(`Guest passes: ${c.code} is used up and has no end date.`);
    return ends ? { kind: "existing", code: c.code, usesLeft: left, endsOn: ends } : person(`Guest passes: ${c.code} has no end date.`);
  }

  // A comp is not a paying member; a person decides.
  if (status === "ADDED_FROM_ADMIN") return person("Guest passes: this membership was added from admin (a comp), so a person decides.");
  if (!(m.price != null && m.price > 0)) return person("Guest passes: the membership price couldn't be read as paying.");
  if (m.canceledAt) return person("Guest passes: this member has cancelled (still playing through the month), so a person decides on a new code.");
  if (!f.slug || !SLUG_RX.test(f.slug)) return person("Guest passes: this member's number couldn't be read, so no code was built.");
  const code = guestCodeName(f.slug);
  // The name is taken by an ended or deleted code: creating it again would be refused as a duplicate.
  const taken = f.codes.find((c) => c.code.toLowerCase() === code.toLowerCase());
  if (taken) return person(`Guest passes: ${taken.code} exists but is ${taken.deleted_at ? "deleted" : "ended"}. A person decides whether to restore it.`);
  const since = m.since ? Date.parse(m.since) : NaN;
  if ((!Number.isFinite(since) || f.now - since < DAY_MS) && !f.staffConfirmed) return person("Guest passes: this membership is under 24 hours old.");
  return { kind: "create", code };
}

// What the model reads. No code, ever: the reply carries {code} and the server fills it in.
export function guestPassForModel(a: GuestPassAnswer | null | undefined) {
  if (!a) return null;
  switch (a.kind) {
    case "ask_phone": return { answer: "ask_phone", say: "We can't tell which account is writing. Ask for the phone number on their MatchDay account (Profile tab). Never ask for a screenshot." };
    case "not_member": return { answer: "not_member", say: "They are not a member. Say kindly that guest passes come with a membership, and in one line how it works (unlimited matches, 3 guest passes a year)." };
    case "create": return { answer: "create", say: `Propose issue_guest_code. Reply: "Your guest code is {code}. Your friends enter it on their own profile while logged in, good for ${GUEST_PASS_USES} uses."` };
    case "existing": return { answer: "existing", uses_left: a.usesLeft, ends_on: a.endsOn, say: `They already have a code. No action. Reply with {code} and that it has ${a.usesLeft} of ${GUEST_PASS_USES} uses left: "Your guest code is {code}. Your friends enter it on their own profile while logged in, ${a.usesLeft} ${a.usesLeft === 1 ? "use" : "uses"} left."` };
    case "used_up": return { answer: "used_up", resets_on: a.resetsOn, say: `All ${GUEST_PASS_USES} uses on {code} are spent. No action, no new code. Say so and that they reset on ${a.resetsOn}.` };
    case "person": return { answer: "person", say: "A teammate handles this one. Promise nothing about a code." };
  }
}

// A literal guest code the model wrote itself. The placeholder is the only way a code reaches a reply.
const LITERAL_CODE_RX = /\b[A-Za-z]{2,5}\d{1,6}FP\b/;

/** Why a guest pass reply can't go out as drafted, or null. */
export function guestReplyProblem(a: GuestPassAnswer, reply: string, actionKind: string | null): string | null {
  if (LITERAL_CODE_RX.test(reply)) return "The reply wrote a guest code itself instead of {code}.";
  const slots = reply.split("{code}").length - 1;
  if (a.kind === "create") {
    if (actionKind !== "issue_guest_code") return "A new guest code needs the issue_guest_code action.";
    return slots === 1 ? null : "The guest code reply must carry {code} once.";
  }
  if (actionKind) return `No action on a guest pass answer of ${a.kind}.`;
  if (a.kind === "existing" || a.kind === "used_up") return slots === 1 ? null : "The reply must carry {code} once.";
  return slots === 0 ? null : "This reply can't carry a code.";
}

/** The code the server writes into {code} before the reply is stored, when no write is needed. */
export const guestCodeToFill = (a: GuestPassAnswer | null | undefined): string | null =>
  a && (a.kind === "existing" || a.kind === "used_up") ? a.code : null;
