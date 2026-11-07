// PLAYER PUSH VISIBILITY, the pure half (Figma 20877:72 / 20877:132 Player Lookup › Pushes, 20877:141 push count tags,
// 20877:188 the send bar). Client-safe.
//
// THE CONTRACT is backend docs/push-notifications.md "Player pushes" (production a71fc05):
//   GET  /admin/push-notifications/players/:id?limit=5|all   one player's pushes, this week, can get pushes, opened
//   POST /admin/push-notifications/players/status             { playerIds, kind } -> this week and skip reason, per player
//   GET  /admin/push-notifications/messages/:id/send-summary  the send bar's numbers, as if it went now
//   GET  /admin/push-notifications/messages/:id/skipped?reason=   "See who"
// Every field below is that section's. Instants are UTC and shown in America/Chicago.

import { chicagoLabel } from "./offersModel";

export type PushKind = "MESSAGE" | "OFFER" | "AUTOMATIC" | "TEST";
export type PlayerPushItem = {
  pushId: number; sentAt: string; kind: PushKind; type: string; title: string; titleAsSent: boolean; name: string | null;
  offerId: number | null; pushCampaignId: number | null; match: { id: number; name: string; fieldName: string | null } | null;
  countsTowardLimit: boolean; opened: boolean | null; openedAt: string | null;
};
export type PlayerPushes = {
  playerId: number; since: string; total: number; items: PlayerPushItem[];
  opened: { opened: number; trackable: number; total: number };
  thisWeek: { count: number; limit: number; atLimit: boolean };
  canGetPushes: { value: boolean; reason: "NO_DEVICE" | "PUSHES_OFF" | null; pushesOn: boolean; hasDevice: boolean };
  devices: { platform: string; appVersion: string | null; updatedAt: string | null }[];
  canGetOffers: { value: boolean; appVersion: string | null; lastOpenedOffersAppAt: string | null };
};
export type SkipReason = "NOT_ALLOWED" | "PUSHES_OFF" | "NO_DEVICE" | "OLDER_APP" | "AT_LIMIT";
export type PlayerStatus = {
  playerId: number; thisWeek: number; weeklyLimit: number; atLimit: boolean; pushesOn: boolean; hasDevice: boolean;
  onOffersApp: boolean; willBeSkipped: boolean; skipReason: SkipReason | null;
};
export type StatusAnswer = { weeklyLimit: number; players: PlayerStatus[]; notFound: number[] };
export type SendSummary = {
  audience: number; canGetIt: number; cantGetIt: { notAllowed: number; pushesOff: number; noDevice: number; olderApp: number };
  skippedAtLimit: number; heldBack: number; willSend: number; weeklyLimit: number; mode: string;
};
export type Skipped = { pushCampaignId: number; reason: string; source: "NOW" | "SENT"; count: number; players: { id: number; name: string | null; city: string | null; thisWeek: number }[] };

const n = (x: number) => x.toLocaleString("en-US");

// ── PLAYER LOOKUP › PUSHES ──────────────────────────────────────────────────────────────────────
export const KIND_LABEL: Record<PushKind, string> = { MESSAGE: "Message", OFFER: "Offer", AUTOMATIC: "Automatic", TEST: "Test" };
export const PLATFORM_LABEL: Record<string, string> = { IOS: "iPhone", ANDROID: "Android" };
export const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p.charAt(0) + p.slice(1).toLowerCase();
// The newest device: the one the "Yes" line names.
export function newestDevice(d: PlayerPushes["devices"]) {
  return [...d].sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || 0)[0] ?? null;
}
// The "Can get pushes" tile: Yes; a device but the account setting off; or the amber "Can't get pushes" note.
export type CanGet = { tone: "yes"; value: "Yes"; sub: string } | { tone: "off"; value: "No"; sub: string } | { tone: "none"; title: string; note: string };
export function canGetView(p: Pick<PlayerPushes, "canGetPushes" | "devices">): CanGet {
  const c = p.canGetPushes;
  if (c.value) {
    const d = newestDevice(p.devices);
    return { tone: "yes", value: "Yes", sub: [d ? platformLabel(d.platform) : null, d?.appVersion ? `app ${d.appVersion}` : null, "pushes on"].filter(Boolean).join(" · ") };
  }
  if (!c.pushesOn && c.hasDevice) return { tone: "off", value: "No", sub: "Phone allows notifications, account setting off" };
  return { tone: "none", title: "Can't get pushes", note: "Pushes are off on this player's phone. They still see offers when they open the app." };
}
// The amber "Older app" line, only when the player can't get offers.
export function olderAppNote(p: Pick<PlayerPushes, "canGetOffers">): { title: string; note: string } | null {
  if (p.canGetOffers.value) return null;
  return { title: `Older app (${p.canGetOffers.appVersion ?? "before 1.88"})`, note: "Gets message pushes, but can't get offers until they update." };
}
export const openedCell = (o: boolean | null) => (o === null ? "—" : o ? "Opened" : "Not opened");
export const sentLabel = (iso: string) => chicagoLabel(iso);
export function footerLine(shown: number, total: number): string {
  const base = "Booking, reminder and cancellation messages never count toward the limit.";
  return total === 0 ? base : `${base} Showing ${shown === total ? "all " : `${n(shown)} of `}${n(total)}.`;
}

// ── PUSH COUNT TAGS (20877:141) ──────────────────────────────────────────────────────────────────
// "N this week" when not skipped, else the reason; the tooltip says why in plain words.
export type Tag = { text: string; amber: boolean; why: string };
export function tagOf(s: PlayerStatus): Tag {
  if (!s.willBeSkipped) return { text: `${n(s.thisWeek)} this week`, amber: false, why: `${n(s.thisWeek)} of ${n(s.weeklyLimit)} pushes this week. They'll get this one.` };
  switch (s.skipReason) {
    case "AT_LIMIT": return { text: `At limit (${n(s.weeklyLimit)})`, amber: true, why: `Already got ${n(s.thisWeek)} pushes this week, the limit is ${n(s.weeklyLimit)}. They'll be skipped.` };
    case "PUSHES_OFF": return { text: "Pushes off", amber: true, why: "Their account has pushes turned off. They'll be skipped." };
    case "NO_DEVICE": return { text: "No device", amber: true, why: "No phone with notifications on is signed in to their account. They'll be skipped." };
    case "OLDER_APP": return { text: "Older app", amber: true, why: "Their app is older than 1.88, which can't show offers. They'll be skipped for an offer push." };
    case "NOT_ALLOWED": return { text: "Not allowed", amber: true, why: "Pushes are limited to the test list on this server. They'll be skipped." };
    default: return { text: "Skipped", amber: true, why: "They'll be skipped." };
  }
}

// ── THE SEND BAR (20877:188) ─────────────────────────────────────────────────────────────────────
// First line: "Sends Sat, Nov 7 · 11:30 AM in each player's city to about 76 players" (or "Sends now to about …").
export function sendFirstLine(when: string | null, willSend: number): string {
  return `Sends ${when ? `${when} in each player's city` : "now"} to about ${n(willSend)} ${willSend === 1 ? "player" : "players"}`;
}
// Second line, before "See who": "84 can get it (the rest have pushes off or an older app). 8 held back to measure
// results. No one skipped by the weekly limit (4)." / "3 skipped: already got 4 pushes this week."
export function sendSecondLine(s: Pick<SendSummary, "canGetIt" | "heldBack" | "skippedAtLimit" | "weeklyLimit">): string {
  const skip = s.skippedAtLimit > 0
    ? `${n(s.skippedAtLimit)} skipped: already got ${n(s.weeklyLimit)} ${s.weeklyLimit === 1 ? "push" : "pushes"} this week.`
    : `No one skipped by the weekly limit (${n(s.weeklyLimit)}).`;
  return `${n(s.canGetIt)} can get it (the rest have pushes off or an older app). ${n(s.heldBack)} held back to measure results. ${skip}`;
}
// The breakdown behind "can get it", for its tooltip.
export function cantGetBreakdown(s: Pick<SendSummary, "audience" | "canGetIt" | "cantGetIt">): string {
  const c = s.cantGetIt;
  const parts = [[c.pushesOff, "pushes off"], [c.noDevice, "no device"], [c.olderApp, "older app"], [c.notAllowed, "not on the test list"]].filter(([k]) => (k as number) > 0).map(([k, w]) => `${n(k as number)} ${w}`);
  return `${n(s.canGetIt)} of ${n(s.audience)} can get it${parts.length ? `; ${parts.join(", ")}` : ""}.`;
}
