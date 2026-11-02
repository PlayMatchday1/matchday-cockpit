// MATCH OPS › OFFERS, THE PUSH THAT GOES WITH AN OFFER (backend docs/offer-push.md, final for 1.88). Client-safe:
// the panel, the routes and scripts/offers-model-test.ts all use it.
//
// The push goes once, at the chosen time, to the popup's audience less the holdout, players who turned pushes
// off, players with no device and players at the shared weekly cap. Who it can reach at all is the API's
// OFFER_PUSH_MODE (off, allowlist, live); the Clubhouse never decides that. A test push goes only to the
// signed-in person's own devices.
//
// TEXT. Title and body follow the deal until someone types, like the popup's own text. Placeholders are
// {first_name} and, on a specific match only, {match}; the backend fills both per player. Popup copy uses
// {firstName}; the push contract uses {first_name}, and the two are not interchangeable.

import { matchTitle, money, wallMs, type FieldOpt, type Form, type MatchOpt } from "./offersModel";

export type PushStatus = "OFF" | "WAITING" | "SCHEDULED" | "SENT" | "NOT_SENT";
export type CampaignPush = { enabled: boolean; title: string | null; body: string | null; sendLocal: string | null; status: PushStatus; queuedAt: string | null };
// absent title or body: following the suggestion. at false: send "now" (at launch, or at once if already live).
export type PushForm = { enabled: boolean; title?: string; body?: string; at: boolean; sendLocal: string };
// oldApp (the backend's skip reason OLD_APP): players whose app is older than 1.88. Absent on a backend that
// doesn't send it, and then no row is drawn for it.
export type Reach = { audience: number; heldBack: number; noConsent: number; noDevice: number; oldApp?: number; capped: number; reachable: number };
export type PushResults = {
  status: PushStatus; sent: number; failed: number; opened: number; bookedWithin72h: number; devices: number;
  skipped: { heldBack: number; noConsent: number; noDevice: number; oldApp?: number; capped: number; notAllowed: number };
};

export const PUSH_TITLE_MAX = 64;
export const PUSH_BODY_MAX = 240;
// Past these a lock screen may cut the text off: a warning, never a block.
export const PUSH_TITLE_SOFT = 50;
export const PUSH_BODY_SOFT = 110;
export const CUT_OFF_NOTE = "May be cut off on the lock screen.";
export const FIRST_NAME = "{first_name}";
export const MATCH_TOKEN = "{match}";
export const PREVIEW_NAME = "Luis";

// Once the sends are queued the backend locks the push (OFFER_PUSH_LOCKED), and an ended offer can't take one.
export const pushLocked = (p: CampaignPush | null | undefined, campaignStatus: string | null) =>
  campaignStatus === "ENDED" || (!!p && (p.status === "SCHEDULED" || p.status === "SENT" || p.status === "NOT_SENT"));

// THE SUGGESTION, from the deal. Any match: "Your next match is 50% off" / "{first_name}, it's already on your
// account. Ends Sun, Nov 8." (no "Ends" with no end date). A specific match: "50% off Parmer Thursday" /
// "{first_name}, Thu Nov 5 7:00 PM. Already applied." (free: "Parmer Thursday is free", set price: "$5 spot at Parmer Thursday"). A field:
// "50% off at Riverside Fields" / "{first_name}, any match there. Already applied." (free: "Any match at Riverside Fields is free"); with no
// field name to hand, the title is the deal alone ("50% off", "$5 spots", "Free match") and the body has no "there". Names and times are
// written in, not left as {match}.
const dealWord = (type: Form["dealType"], amount: number) =>
  type === "PERCENT_OFF" ? `${amount}% off` : type === "AMOUNT_OFF" ? `${money(amount)} off` : type === "SET_PRICE" ? money(amount) : "free";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const andJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
export function pushSuggestion(f: Pick<Form, "dealType" | "dealAmount" | "usesPerPlayer" | "scope" | "appliesFieldIds" | "endsLocal">, m: MatchOpt | null, fields: FieldOpt[]): { title: string; body: string } {
  const w = dealWord(f.dealType, f.dealAmount);
  let title: string, body: string;
  if (f.scope === "MATCH" && m) {
    title = f.dealType === "FREE_MATCH" ? `${matchTitle(m)} is free` : f.dealType === "SET_PRICE" ? `${w} spot at ${matchTitle(m)}` : `${cap(w)} ${matchTitle(m)}`;
    body = `${FIRST_NAME}, ${matchWhen(m)}. Already applied.`;
  } else if (f.scope === "FIELD" && f.appliesFieldIds.length) {
    const at = f.appliesFieldIds.map((id) => fields.find((x) => x.id === id)?.title).filter(Boolean) as string[];
    if (at.length) {
      title = f.dealType === "FREE_MATCH" ? `Any match at ${andJoin(at)} is free` : `${cap(w)} at ${andJoin(at)}`;
      body = `${FIRST_NAME}, any match there. Already applied.`;
    } else {
      title = f.dealType === "FREE_MATCH" ? "Free match" : f.dealType === "SET_PRICE" ? `${w} spots` : cap(w);
      body = `${FIRST_NAME}, it's already on your account.`;
    }
  } else {
    title = f.usesPerPlayer === 1 ? `Your next match is ${w}` : `Your next ${f.usesPerPlayer} matches are ${w}`;
    body = `${FIRST_NAME}, it's already on your account.${f.endsLocal === null ? "" : ` Ends ${endDay(f.endsLocal)}.`}`;
  }
  return { title: title.slice(0, PUSH_TITLE_MAX), body };
}

// "At a time" starts at the next whole hour, Chicago wall clock, as "YYYY-MM-DD HH:mm".
export function defaultSendLocal(nowWall: string): string {
  const ms = wallMs(nowWall);
  return new Date(Math.floor(ms / 3600e3) * 3600e3 + 3600e3).toISOString().slice(0, 16).replace("T", " ");
}
// The form for a campaign's stored push. Stored text equal to today's suggestion is following it.
export function pushFormOf(p: CampaignPush | null | undefined, sugg: { title: string; body: string }, defaultAt: string): PushForm {
  if (!p || !p.enabled) return { enabled: false, at: false, sendLocal: defaultAt };
  const out: PushForm = { enabled: true, at: p.sendLocal !== null, sendLocal: p.sendLocal ?? defaultAt };
  if (p.title !== null && p.title !== sugg.title) out.title = p.title;
  if (p.body !== null && p.body !== sugg.body) out.body = p.body;
  return out;
}
export const pushText = (pf: PushForm, sugg: { title: string; body: string }) => ({ title: pf.title ?? sugg.title, body: pf.body ?? sugg.body });
// Typing the suggestion itself goes back to following it.
export const pushAfterType = (pf: PushForm, k: "title" | "body", text: string, sugg: { title: string; body: string }): PushForm => {
  const next = { ...pf };
  if (text === sugg[k]) delete next[k]; else next[k] = text;
  return next;
};

// THE PUT BODY. Off sends only enabled false.
export function pushBodyOf(pf: PushForm, sugg: { title: string; body: string }): Record<string, unknown> {
  if (!pf.enabled) return { enabled: false };
  const t = pushText(pf, sugg);
  return { enabled: true, title: t.title, body: t.body, sendLocal: pf.at ? pf.sendLocal : null };
}
// Whether the stored push differs from the form: what a Save would PUT.
export function pushDirty(p: CampaignPush | null | undefined, pf: PushForm, sugg: { title: string; body: string }): boolean {
  const want = pushBodyOf(pf, sugg);
  if (!p || !p.enabled) return want.enabled === true;
  if (!want.enabled) return true;
  return want.title !== p.title || want.body !== p.body || (want.sendLocal ?? null) !== (p.sendLocal ?? null);
}

const LOCAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
// What stops the push saving, in plain words. Null: nothing.
export function pushProblem(pf: PushForm, sugg: { title: string; body: string }, scope: Form["scope"]): string | null {
  if (!pf.enabled) return null;
  const t = pushText(pf, sugg);
  if (!t.title.trim()) return "The push needs a title.";
  if (!t.body.trim()) return "The push needs a body.";
  if (t.title.length > PUSH_TITLE_MAX) return `The push title is over ${PUSH_TITLE_MAX} characters.`;
  if (t.body.length > PUSH_BODY_MAX) return `The push body is over ${PUSH_BODY_MAX} characters.`;
  if (scope !== "MATCH" && (t.title.includes(MATCH_TOKEN) || t.body.includes(MATCH_TOKEN))) return `${MATCH_TOKEN} only works on an offer for a specific match.`;
  if (pf.at && !LOCAL.test(pf.sendLocal)) return "Set when the push goes out.";
  return null;
}

// THE PREVIEW, as one player sees it: {first_name} as Luis, {match} as the backend writes it
// ("ZZ probe offers A, Tue Nov 3 7:00 PM": the match's name, then its day and time).
const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(new Date(ms));
// "Thu Nov 5 7:00 PM", the match's own wall clock, as the backend's matchLabel writes it.
const matchWhen = (m: MatchOpt) => {
  const ms = wallMs(m.startLocal);
  return `${fmt(ms, { weekday: "short" })} ${fmt(ms, { month: "short" })} ${fmt(ms, { day: "numeric" })} ${fmt(ms, { hour: "numeric", minute: "2-digit" })}`;
};
// "Sun, Nov 8"
const endDay = (endsLocal: string) => {
  const ms = wallMs(endsLocal);
  return `${fmt(ms, { weekday: "short" })}, ${fmt(ms, { month: "short" })} ${fmt(ms, { day: "numeric" })}`;
};
export const matchForPush = (m: MatchOpt) => `${matchTitle(m)}, ${matchWhen(m)}`;
// With no first name, the backend (push-copy.ts fillPushText over personalize.ts fillFirstName) drops the token
// with the comma or space it would leave, and when the text opened with it, capitalizes what is left ("It's
// already on your account"). This is that, so the preview shows what is sent.
export function dropFirstName(text: string): string {
  if (!text.includes(FIRST_NAME)) return text;
  const left = text
    .replace(/\s*,\s*\{first_name\}\s*,/g, "")
    .replace(/\s*,\s*\{first_name\}/g, "")
    .replace(/\{first_name\}\s*,\s*/g, "")
    .split(FIRST_NAME).join("")
    .replace(/\s+([!?.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text.trimStart().startsWith(FIRST_NAME) ? left.charAt(0).toUpperCase() + left.slice(1) : left;
}
export const fillPush = (text: string, m: MatchOpt | null, name: string | null = PREVIEW_NAME) =>
  (name === null ? dropFirstName(text) : text.split(FIRST_NAME).join(name)).split(MATCH_TOKEN).join(m ? matchForPush(m) : MATCH_TOKEN);
// The lock-screen warning counts what a player sees (as the preview fills it), not the template: {match} alone
// writes in the match's name, day and time. Past the hard limit the limit's own message says it instead.
export const mayCutOff = (text: string, soft: number, max: number, m: MatchOpt | null) => text.length <= max && fillPush(text, m).length > soft;

// The confirm before a push goes: who it reaches, from GET .../push/reachable.
export const sendsToLine = (reachable: number) => `Sends to ${reachable.toLocaleString("en-US")} ${reachable === 1 ? "player" : "players"}.`;

// The send time against the offer's run: a push before it starts or after it ends promises nothing usable.
export function sendTimeNote(pf: PushForm, startsLocal: string, endsLocal: string | null): string | null {
  if (!pf.enabled || !pf.at || !LOCAL.test(pf.sendLocal)) return null;
  const at = wallMs(`${pf.sendLocal}:00`);
  if (at < wallMs(startsLocal)) return "That's before the offer starts, so players would get a push for an offer they can't use yet.";
  if (endsLocal !== null && at >= wallMs(endsLocal)) return "That's after the offer ends, so nobody could use it.";
  return null;
}

// "Who it reaches" broken down, in the order the backend takes them away.
const hasOld = (x: { oldApp?: number }) => typeof x.oldApp === "number";
export const reachRows = (r: Reach): [string, number][] => [
  ["Audience", r.audience], ["Held back to measure", -r.heldBack], ["Pushes turned off", -r.noConsent], ["No phone to send to", -r.noDevice],
  ...(hasOld(r) ? [["Old app", -r.oldApp!] as [string, number]] : []), ["At the weekly limit", -r.capped],
];
export const reachAddsUp = (r: Reach) => r.audience - r.heldBack - r.noConsent - r.noDevice - (r.oldApp ?? 0) - r.capped === r.reachable;
export const skippedTotal = (s: PushResults["skipped"]) => s.heldBack + s.noConsent + s.noDevice + (s.oldApp ?? 0) + s.capped + s.notAllowed;
export const skippedRows = (s: PushResults["skipped"]): [string, number][] => [
  ["Held back to measure", s.heldBack], ["Pushes turned off", s.noConsent], ["No phone", s.noDevice],
  ...(hasOld(s) ? [["Old app", s.oldApp!] as [string, number]] : []), ["At the weekly limit", s.capped], ["Not allowed yet (safety switch)", s.notAllowed],
];
export const STATUS_TEXT: Record<PushStatus, string> = {
  OFF: "Off", WAITING: "Goes when the offer launches", SCHEDULED: "Queued, sending", SENT: "Sent", NOT_SENT: "Not sent: the offer was paused or ended first",
};

// The shared weekly limit (push-settings): 0 to 14, 0 stops all marketing pushes.
export const CAP_MIN = 0;
export const CAP_MAX = 14;
export const capLine = (n: number) => (n === 0
  ? "No marketing pushes at all: offer pushes, Spots available and the three come-back pushes all stop. Cancellations and chat still go."
  : `Each player gets at most ${n} marketing ${n === 1 ? "push" : "pushes"} in any 7 days, counting offer pushes, Spots available and the three come-back pushes. Cancellations and chat never count.`);

// WHO SEES THE PUSH CONTROLS: everywhere but production, and on production only the accounts in
// OFFERS_PUSH_ACCOUNTS (comma-separated emails) until Ryan signs off. Unset on production: nobody.
export function pushesVisible(env: string, email: string | null | undefined, vars: Record<string, string | undefined>): boolean {
  if (env !== "production") return true;
  const list = (vars.OFFERS_PUSH_ACCOUNTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
  return !!email && list.includes(email.trim().toLowerCase());
}
