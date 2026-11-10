// MATCH OPS › OFFERS › OFFER RESULTS, the pure half (Figma 20864:72 "Offer results · Funnel"). Client-safe.
//
// THE CONTRACT is backend docs/offers/M3-ENDPOINTS.md "Funnel" (feature/offer-funnel, 97be675). Every field here is
// that section's: GET /admin/offers/campaigns/funnel?from=&to= (offers launched in [from, to), totals, planner) and
// GET /admin/offers/campaigns/:id/players-without-app. Step rates are the page's to work out, guarded against 0.
//
// Each offer row carries matchId (null for any-match and field offers) and endedAt (UTC; null while live, scheduled or
// paused before its end), backend d44fb4c. The row has no fields, so a field offer's Deal line still comes from the
// same campaign in the page's own list, by id.

import { dealText, scopeFieldsLine, wallMs, type Campaign, type CampaignState, type DealType, type FieldOpt } from "./offersModel";

// kind and tapped (announcements.md "Funnel"): an ANNOUNCEMENT (no discount) has used null and counts tapped instead; an
// OFFER keeps used. Absent on a backend from before announcements, which is the same as OFFER.
export type Funnel = { kind?: "OFFER" | "ANNOUNCEMENT"; chosen: number; canGetIt: number; canGetItPushesOn: number; estimated: boolean; snapshotAt: string | null; saw: number; tapped?: number; used: number | null };
export type FunnelOffer = {
  id: number; name: string; status: string; state: CampaignState; dealType: DealType; dealAmount: number;
  launchedAt: string | null; startsLocal: string; endsLocal: string | null; matchId: number | null; endedAt: string | null; funnel: Funnel;
};
export type FunnelTotals = { chosen: number; canGetIt: number; canGetItPushesOn: number; saw: number; used: number; offers: number; estimatedOffers: number };
export type Planner = { used: number; chosen: number; useRate: number | null; minUsed: number; enoughData: boolean };
// totals and planner are offers with a deal only; announcements get their own totals (never in the use rate).
export type AnnouncementTotals = { chosen: number; canGetIt: number; canGetItPushesOn: number; saw: number; tapped: number; estimatedOffers: number; offers: number };
export type FunnelPage = { from: string; to: string; totals: FunnelTotals; planner: Planner; offers: FunnelOffer[]; announcements?: AnnouncementTotals };
export type WithoutApp = { campaignId: number; count: number; playerIds: number[] };

// THE RANGE PILL: Last 30 days is the backend's own default (no from/to sent).
export type Range = 7 | 30 | 90;
export const RANGES: { days: Range; label: string }[] = [{ days: 7, label: "Last 7 days" }, { days: 30, label: "Last 30 days" }, { days: 90, label: "Last 90 days" }];
export const DEFAULT_RANGE: Range = 30;
// "from" as an ISO date, days back from now (UTC day). 30 sends nothing.
export function rangeQuery(days: Range, now = Date.now()): string {
  if (days === DEFAULT_RANGE) return "";
  return `?from=${new Date(now - days * 86400_000).toISOString().slice(0, 10)}`;
}

// A step's share of the step before, as a whole percent; null when the step before is 0.
export const share = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);
export const pctText = (p: number | null) => (p === null ? "—" : `${p}%`);
// A bar's width, scaled to Chosen (0 to 100).
export const barWidth = (part: number, chosen: number) => (chosen > 0 ? Math.max(0, Math.min(100, (part / chosen) * 100)) : 0);

export type Step = { key: "chosen" | "canGetIt" | "saw" | "used" | "tapped"; label: string; count: number; pct: number | null; of: string; bar: number };
export const isAnnouncementFunnel = (f: Pick<Funnel, "kind">) => f.kind === "ANNOUNCEMENT";
// WHO "CAN GET IT" (backend offer-funnel.service.ts, production 8965437). The two kinds really do differ:
// - an offer with a deal: on app 1.88 or newer (DEFAULT_MIN_APP_VERSION in audience.sql.ts, one value for every offer,
//   compared part by part as numbers), from a device's X-App-Version or users.offers_app_seen_at.
// - an announcement: on an app that has asked for popup version 2 (users.announcements_app_seen_at). Only 1.89 store
//   builds running the over-the-air bundle released 2026-11-09 (iOS 19:24Z, Android 19:26Z, app commit d7d8e8d3) ask
//   for it; the backend never hands a no-deal popup to 1.88, or to 1.89 on its built-in bundle, so "1.89+" alone would
//   count players who cannot see it. The bundle is downloaded on one launch and used from the next cold start.
// Both are counted once, at first launch (snapshotAt), and never again.
export const OFFER_APP_NOTE = "on app 1.88+";
export const ANNOUNCEMENT_APP_NOTE = "on app 1.89 with the Nov 9 update";

// SAW IT NEVER OUTRUNS CAN GET IT. The backend's Can get it is that launch snapshot, while Saw it keeps counting, so an
// announcement launched while players were still picking up the update shows more saw than could get (Oglethorpe,
// 2026-11-10: 28 at launch, 38 saw). A player who saw it could get it, so Can get it here is at least Saw it. The true
// figure (the snapshot's players plus the ones who saw it) needs per-player data only the backend has; the larger of
// the two is the most the page can say without it, and never more than the truth.
export const withSawCounted = (f: Funnel): Funnel => (f.saw > f.canGetIt ? { ...f, canGetIt: f.saw } : f);
// The page as drawn: every offer's funnel through withSawCounted, and each kind's totals raised by what that added.
export function countedPage(p: FunnelPage): FunnelPage {
  const added = { OFFER: 0, ANNOUNCEMENT: 0 };
  const offers = p.offers.map((o) => {
    if (!o.funnel) return o; // a draft's funnel is null on the wire
    const f = withSawCounted(o.funnel);
    added[isAnnouncementFunnel(o.funnel) ? "ANNOUNCEMENT" : "OFFER"] += f.canGetIt - o.funnel.canGetIt;
    return f === o.funnel ? o : { ...o, funnel: f };
  });
  const totals = { ...p.totals, canGetIt: p.totals.canGetIt + added.OFFER };
  const announcements = p.announcements && { ...p.announcements, canGetIt: p.announcements.canGetIt + added.ANNOUNCEMENT };
  return { ...p, offers, totals, ...(announcements ? { announcements } : {}) };
}
export function steps(f: Pick<Funnel, "chosen" | "canGetIt" | "saw" | "used"> & { kind?: Funnel["kind"]; tapped?: number }): Step[] {
  if (f.kind === "ANNOUNCEMENT") {
    const tapped = f.tapped ?? 0;
    return [
      { key: "chosen", label: "Chosen", count: f.chosen, pct: null, of: "players picked by filters", bar: f.chosen > 0 ? 100 : 0 },
      { key: "canGetIt", label: "Can get it", count: f.canGetIt, pct: share(f.canGetIt, f.chosen), of: "of chosen", bar: barWidth(f.canGetIt, f.chosen) },
      { key: "saw", label: "Saw it", count: f.saw, pct: share(f.saw, f.canGetIt), of: "of can get it", bar: barWidth(f.saw, f.chosen) },
      { key: "tapped", label: "Tapped", count: tapped, pct: share(tapped, f.saw), of: "of saw it", bar: barWidth(tapped, f.chosen) },
    ];
  }
  const used = f.used ?? 0;
  return [
    { key: "chosen", label: "Chosen", count: f.chosen, pct: null, of: "players picked by filters", bar: f.chosen > 0 ? 100 : 0 },
    { key: "canGetIt", label: "Can get it", count: f.canGetIt, pct: share(f.canGetIt, f.chosen), of: "of chosen", bar: barWidth(f.canGetIt, f.chosen) },
    { key: "saw", label: "Saw it", count: f.saw, pct: share(f.saw, f.canGetIt), of: "of can get it", bar: barWidth(f.saw, f.chosen) },
    { key: "used", label: "Used it", count: used, pct: share(used, f.saw), of: "of saw it", bar: barWidth(used, f.chosen) },
  ];
}
// The tile's second line: "28% of chosen", or the Chosen tile's own words.
export const tileSub = (s: Step) => (s.key === "chosen" ? s.of : `${pctText(s.pct)} ${s.of}`);

// THE BANNER: chosen players who can't get offers (older app, and the held back, as the contract says).
export function cantGetLine(t: Pick<FunnelTotals, "chosen" | "canGetIt">): string | null {
  const n = t.chosen - t.canGetIt;
  if (n <= 0) return null;
  return `${n.toLocaleString("en-US")} of ${t.chosen.toLocaleString("en-US")} chosen players can't get offers yet (older app). Add a message push to reach them.`;
}

// THE PLANNER: N = ceil(need ÷ useRate), only once the backend says there is enough data.
export const DEFAULT_NEED = 10;
export type PlannerView = { ready: true; choose: number; rate: string } | { ready: false; note: string };
export function plannerView(p: Planner, need: number): PlannerView {
  if (!p.enoughData || p.useRate === null || p.useRate <= 0) {
    return { ready: false, note: `Needs ${p.minUsed} used offers to estimate. So far ${p.used.toLocaleString("en-US")} used from ${p.chosen.toLocaleString("en-US")} chosen.` };
  }
  const rate = Math.round(p.useRate * 1000) / 10;
  return { ready: true, choose: Math.ceil(Math.max(0, need) / p.useRate), rate: `${rate.toLocaleString("en-US")}% use rate` };
}

// A wall-clock time read as America/Chicago, as an instant. The start has no zone (each player's city); Chicago is the
// Clubhouse's display zone, so a start elsewhere can be a few hours off, which can move "ran N days" by one at most.
export function chicagoWallMs(wall: string): number {
  const guess = wallMs(wall);
  if (!Number.isFinite(guess)) return NaN;
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}
// How long it ran, in whole days rounded up (at least 1): from the later of launchedAt and the start, to endedAt.
export function ranDays(o: Pick<FunnelOffer, "launchedAt" | "startsLocal" | "endedAt">): number | null {
  if (!o.endedAt) return null;
  const end = Date.parse(o.endedAt);
  const launched = o.launchedAt ? Date.parse(o.launchedAt) : NaN;
  const start = chicagoWallMs(o.startsLocal);
  const from = Math.max(...[launched, start].filter(Number.isFinite));
  if (!Number.isFinite(end) || !Number.isFinite(from)) return null;
  return Math.max(1, Math.ceil((end - from) / DAY));
}
// A row's status line: "Ended · ran 1 day", "Live · ends Sun, Nov 9", "Paused", "Scheduled".
const DAY = 86400_000;
export function statusLine(o: Pick<FunnelOffer, "state" | "startsLocal" | "endsLocal" | "launchedAt" | "endedAt">): string {
  const label = { DRAFT: "Draft", SCHEDULED: "Scheduled", LIVE: "Live", PAUSED: "Paused", ENDED: "Ended" }[o.state] ?? o.state;
  const ran = ranDays(o);
  if (o.state === "ENDED") return ran === null ? label : `${label} · ran ${ran} ${ran === 1 ? "day" : "days"}`;
  const end = o.endsLocal ? wallMs(o.endsLocal) : NaN;
  if (o.state === "LIVE" && Number.isFinite(end)) {
    return `${label} · ends ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(end))}`;
  }
  return label;
}
// The Deal column: "50% off" over "Match 20705" (the row's matchId), a field offer's fields, or Any match.
export function dealLines(o: Pick<FunnelOffer, "id" | "dealType" | "dealAmount" | "matchId">, campaigns: Campaign[], fields: FieldOpt[]): [string, string] {
  const deal = dealText(o.dealType, o.dealAmount);
  if (o.matchId !== null) return [deal, `Match ${o.matchId}`];
  const c = campaigns.find((x) => x.id === o.id);
  return [deal, c?.appliesFieldIds?.length ? scopeFieldsLine(c, fields) : "Any match"];
}

// "Add message push" hands the players to the Push Notifications editor through this browser's session storage (a list
// can run to thousands of ids, too long for a link). Read once and removed.
export const PREFILL_KEY = "clubhouse.pushPrefill";
export type Prefill = { playerIds: number[]; from: string };
