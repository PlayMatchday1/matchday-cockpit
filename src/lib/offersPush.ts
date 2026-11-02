// MATCH OPS › OFFERS, THE PUSH THAT GOES WITH AN OFFER (backend docs/offer-push.md, final for 1.88). Client-safe:
// the panel, the routes and scripts/offers-model-test.ts all use it.
//
// The push goes once, at the chosen time, to the popup's audience less the holdout, players who turned pushes
// off, players with no device and players at the shared weekly cap. Who it can reach at all is the API's
// OFFER_PUSH_MODE (off, allowlist, live); the Clubhouse never decides that. A test push goes only to the
// signed-in person's own devices.
//
// TEXT. Title and body follow the popup until someone types, like the popup's own text. Placeholders are
// {first_name} and, on a specific match only, {match}; the backend fills both per player. Popup copy uses
// {firstName}; the push contract uses {first_name}, and the two are not interchangeable.

import { dealText, matchTitle, money, wallMs, type Copy, type FieldOpt, type Form, type MatchOpt } from "./offersModel";

export type PushStatus = "OFF" | "WAITING" | "SCHEDULED" | "SENT" | "NOT_SENT";
export type CampaignPush = { enabled: boolean; title: string | null; body: string | null; sendLocal: string | null; status: PushStatus; queuedAt: string | null };
// absent title or body: following the suggestion. at false: send "now" (at launch, or at once if already live).
export type PushForm = { enabled: boolean; title?: string; body?: string; at: boolean; sendLocal: string };
export type Reach = { audience: number; heldBack: number; noConsent: number; noDevice: number; capped: number; reachable: number };
export type PushResults = {
  status: PushStatus; sent: number; failed: number; opened: number; bookedWithin72h: number; devices: number;
  skipped: { heldBack: number; noConsent: number; noDevice: number; capped: number; notAllowed: number };
};

export const PUSH_TITLE_MAX = 64;
export const PUSH_BODY_MAX = 240;
export const FIRST_NAME = "{first_name}";
export const MATCH_TOKEN = "{match}";
export const PREVIEW_NAME = "Luis";

// Once the sends are queued the backend locks the push (OFFER_PUSH_LOCKED), and an ended offer can't take one.
export const pushLocked = (p: CampaignPush | null | undefined, campaignStatus: string | null) =>
  campaignStatus === "ENDED" || (!!p && (p.status === "SCHEDULED" || p.status === "SENT" || p.status === "NOT_SENT"));

// THE SUGGESTION: the title is the popup's headline; the body says the deal and where.
export function pushSuggestion(f: Pick<Form, "dealType" | "dealAmount" | "usesPerPlayer" | "scope" | "appliesFieldIds">, copy: Pick<Copy, "headline">, m: MatchOpt | null, fields: FieldOpt[]): { title: string; body: string } {
  const n = m ? 1 : f.usesPerPlayer;
  const at = f.scope === "FIELD" ? f.appliesFieldIds.map((id) => fields.find((x) => x.id === id)?.title).filter(Boolean) as string[] : [];
  const where = m ? MATCH_TOKEN : at.length ? `any match at ${at.length === 1 ? at[0] : `${at.slice(0, -1).join(", ")} and ${at[at.length - 1]}`}` : n === 1 ? "your next match" : `your next ${n} matches`;
  const what = f.dealType === "FREE_MATCH" ? (m ? `${MATCH_TOKEN} is free for you` : `a free match: ${where}`)
    : f.dealType === "SET_PRICE" ? `a ${money(f.dealAmount)} spot in ${where}`
    : `${dealText(f.dealType, f.dealAmount)} ${where}`;
  return { title: copy.headline.slice(0, PUSH_TITLE_MAX), body: `${FIRST_NAME}, ${what}. It's already on your account.` };
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
export const matchForPush = (m: MatchOpt) => {
  const ms = wallMs(m.startLocal);
  return `${matchTitle(m)}, ${fmt(ms, { weekday: "short" })} ${fmt(ms, { month: "short" })} ${fmt(ms, { day: "numeric" })} ${fmt(ms, { hour: "numeric", minute: "2-digit" })}`;
};
export const fillPush = (text: string, m: MatchOpt | null) =>
  text.split(FIRST_NAME).join(PREVIEW_NAME).split(MATCH_TOKEN).join(m ? matchForPush(m) : MATCH_TOKEN);

// The send time against the offer's run: a push before it starts or after it ends promises nothing usable.
export function sendTimeNote(pf: PushForm, startsLocal: string, endsLocal: string | null): string | null {
  if (!pf.enabled || !pf.at || !LOCAL.test(pf.sendLocal)) return null;
  const at = wallMs(`${pf.sendLocal}:00`);
  if (at < wallMs(startsLocal)) return "That's before the offer starts, so players would get a push for an offer they can't use yet.";
  if (endsLocal !== null && at >= wallMs(endsLocal)) return "That's after the offer ends, so nobody could use it.";
  return null;
}

// "Who it reaches" broken down, in the order the backend takes them away.
export const reachRows = (r: Reach): [string, number][] => [
  ["Audience", r.audience], ["Held back to measure", -r.heldBack], ["Pushes turned off", -r.noConsent], ["No phone to send to", -r.noDevice], ["At the weekly limit", -r.capped],
];
export const reachAddsUp = (r: Reach) => r.audience - r.heldBack - r.noConsent - r.noDevice - r.capped === r.reachable;
export const skippedTotal = (s: PushResults["skipped"]) => s.heldBack + s.noConsent + s.noDevice + s.capped + s.notAllowed;
export const skippedRows = (s: PushResults["skipped"]): [string, number][] => [
  ["Held back to measure", s.heldBack], ["Pushes turned off", s.noConsent], ["No phone", s.noDevice], ["At the weekly limit", s.capped], ["Not allowed yet (safety switch)", s.notAllowed],
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
