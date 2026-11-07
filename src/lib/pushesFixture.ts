import "server-only";
// A STAND-IN for the Push Notifications backend (docs/push-notifications.md shapes), on a dev server only
// (PUSHES_FIXTURE=1; src/lib/pushesServer.ts refuses it under NODE_ENV=production and on Vercel). It exists so the
// screens can be looked at before the backend reaches staging. Everything here is made up, lives in this process's
// memory, and reaches no player and no change_log row. Delete it once the backend is on staging.

import type { ContractAudience, ContractCount, TokenLookup } from "@/lib/audienceModel";
import type { FunnelPage, WithoutApp } from "@/lib/offersFunnel";
import type { ListItem, ListPage, PushGroup, PushMessage, PushReachable, PushResultsData, PushState } from "@/lib/pushesModel";

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
const groupOf = (s: PushState): PushGroup => (s === "DRAFT" ? "DRAFTS" : s === "ENDED" ? "ENDED" : s === "SCHEDULED" || s === "PAUSED" ? "SCHEDULED" : "LIVE");
const base = (id: number, name: string, over: Partial<PushMessage>): PushMessage => {
  const m: PushMessage = {
    kind: "MESSAGE", id, name, audience: { mode: "FILTERS", filters: [{ type: "CITY", op: "IN", cityIds: [1] }] }, audienceCount: 946, holdoutPercent: 10,
    title: "6 spots left Saturday at NEMP", body: "{first_name}, Sat 7:00 PM in Austin. Grab one before it fills.",
    tap: { target: "HOME", effectiveTarget: "HOME", matchId: null, fieldId: null, match: null }, schedule: "ONCE", sendLocal: null,
    status: "DRAFT", state: "DRAFT", group: "DRAFTS", queuedAt: null, createdByStaffEmail: "rmancuso@playmatchday.com", launchedByStaffEmail: null, launchedAt: null, endedAt: null,
    createdAt: iso(30), updatedAt: iso(1), ...over,
  };
  return { ...m, group: groupOf(m.state) };
};
const RESULTS: Record<number, PushResultsData> = {
  1: { targeted: 946, sent: 880, failed: 2, skipped: { notAllowed: 0, noConsent: 0, noDevice: 12, oldApp: 0, capped: 7 }, opened: 74, openRate: 0.084, bookedWithin3Days: 9, bookingRate: 0.0102, heldBack: 105, heldBackBooked: 2, heldBackBookingRate: 0.019, devices: 913, sentAt: iso(3), launchedAt: iso(3), launchedByStaffEmail: "miguel@playmatchday.com" },
  4: { targeted: 1284, sent: 1051, failed: 0, opened: 88, openRate: 0.0837, bookedWithin3Days: 61, bookingRate: 0.058, heldBack: 128, heldBackBooked: 4, heldBackBookingRate: 0.031, sentAt: iso(24 * 12), launchedAt: iso(24 * 12), launchedByStaffEmail: "rmancuso@playmatchday.com" },
};
const store = new Map<number, PushMessage>();
let next = 1;
function seed() {
  if (store.size) return;
  const rows: PushMessage[] = [
    base(1, "Austin · Saturday NEMP fill", { status: "LAUNCHED", state: "SENT", launchedAt: iso(3), queuedAt: iso(3), launchedByStaffEmail: "miguel@playmatchday.com" }),
    base(2, "Dallas Sunday reminder", { title: "Sunday pickup in Dallas", body: "{first_name}, there's a spot for you Sunday morning.", status: "LAUNCHED", state: "SCHEDULED", sendLocal: "2026-11-08 09:00", queuedAt: iso(20), audience: { mode: "FILTERS", filters: [{ type: "CITY", op: "IN", cityIds: [2] }] }, audienceCount: 2010 }),
    base(3, "Members we miss", { title: "We miss you on the pitch", body: "{first_name}, your membership is waiting. Pick a match this week.", audience: { mode: "FILTERS", filters: [{ type: "MEMBERSHIP", value: "MEMBER" }, { type: "LAST_PLAYED", op: "MORE_THAN_DAYS", days: 30 }] }, audienceCount: null }),
    base(4, "October win-back", { status: "ENDED", state: "ENDED", launchedAt: iso(24 * 12), queuedAt: iso(24 * 12), endedAt: iso(24 * 9), launchedByStaffEmail: "rmancuso@playmatchday.com", audienceCount: 1284 }),
  ];
  for (const r of rows) store.set(r.id, r);
  next = 900;
}
const item = (m: PushMessage): ListItem => {
  const r = RESULTS[m.id];
  const city = m.audience.mode === "FILTERS" ? m.audience.filters.find((f) => f.type === "CITY" && f.op === "IN") : undefined;
  return {
    kind: "MESSAGE", id: m.id, name: m.name, state: m.state, group: m.group, players: m.audienceCount, cityIds: (city?.cityIds as number[]) ?? [], tap: m.tap, offer: null, sendLocal: m.sendLocal,
    results: r ? { sent: r.sent, opened: r.opened, bookedWithin3Days: r.bookedWithin3Days, used: null } : null, launchedAt: m.launchedAt, launchedByStaffEmail: m.launchedByStaffEmail, createdAt: m.createdAt ?? null,
  };
};
const OFFER_ITEM: ListItem = {
  kind: "OFFER", id: 36, name: "Austin win-back 50% (stand-in)", state: "LIVE", group: "LIVE", players: 1284, cityIds: [1], tap: { target: "FIND_MATCH", matchId: null, fieldId: null, match: null },
  offer: { id: 36, dealType: "PERCENT_OFF", dealAmount: 50, scope: "ANY_MATCH", pushStatus: "SENT" }, sendLocal: null,
  results: { sent: 1051, opened: 88, bookedWithin3Days: 70, used: 61 }, launchedAt: iso(5), launchedByStaffEmail: "rmancuso@playmatchday.com", createdAt: iso(48),
};

const NAMES = ["Ryan M.", "Diego R.", "Luis P.", "Sam K.", "Ana T.", "Marcus L.", "Priya N.", "Jordan W."];
const CITIES = ["Austin", "Dallas", "Houston", "San Antonio"];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export const fixture = {
  list(): ListPage {
    seed();
    const items = [...[...store.values()].map(item), OFFER_ITEM].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
    const c = (g: PushGroup) => items.filter((i) => i.group === g).length;
    return { counts: { live: c("LIVE"), scheduled: c("SCHEDULED"), drafts: c("DRAFTS"), ended: c("ENDED") }, items };
  },
  get(id: number): PushMessage | null { seed(); return store.get(id) ?? null; },
  results(id: number): PushResultsData { seed(); return RESULTS[id] ?? { targeted: 0, sent: 0, failed: 0, opened: 0, openRate: null, bookedWithin3Days: 0, bookingRate: null, heldBack: 0, heldBackBooked: 0, heldBackBookingRate: null, sentAt: null, launchedAt: null, launchedByStaffEmail: null }; },
  reachable(id: number): PushReachable { seed(); const a = store.get(id)?.audienceCount ?? 400; return { mode: "live", reason: null, audience: a, notAllowed: 0, noConsent: Math.round(a * 0.15), noDevice: 12, oldApp: 0, capped: 38, heldBack: Math.round(a * 0.07), reachable: Math.round(a * 0.7) }; },
  count(a: ContractAudience, holdoutPercent = 10): ContractCount {
    if (a.mode === "PLAYERS") { const m = a.playerIds.length; const allow = m - Math.floor(m / 5); const hp = m < 200 ? 0 : holdoutPercent; const hb = Math.round((allow * hp) / 100); return { matching: m, allowPushes: allow, on188: allow, holdoutPercent: hp, heldBack: hb, willSend: allow - hb }; }
    const h = hash(JSON.stringify(a.filters));
    const matching = Math.max(0, Math.round(2600 / (1 + a.filters.length * 0.9)) - (h % 97));
    const allowPushes = Math.round(matching * 0.82);
    const atCap = Math.round(allowPushes * 0.08);
    const heldBack = Math.round(((allowPushes - atCap) * holdoutPercent) / 100);
    return { matching, allowPushes, on188: Math.round(matching * 0.6), atCap, weeklyCap: 3, holdoutPercent, heldBack, willSend: allowPushes - atCap - heldBack };
  },
  sample(a: ContractAudience) {
    const c = fixture.count(a);
    return { players: Array.from({ length: Math.min(25, c.matching) }, (_, i) => ({ id: 100 + i * 37, name: NAMES[i % NAMES.length], city: CITIES[i % CITIES.length], lastPlayedAt: i % 3 === 0 ? null : iso(24 * (3 + i * 4)) })) };
  },
  lookup(entries: string[]): TokenLookup {
    const players: TokenLookup["players"] = [];
    const notFound: string[] = [];
    for (const e of entries) {
      const id = /^#?\d+$/.test(e) ? Number(e.replace("#", "")) : e.toLowerCase() === "luis@example.com" ? 4410 : e.toLowerCase() === "rmancuso@playmatchday.com" ? 3193 : null;
      if (id === null || (/^#?\d+$/.test(e) && id % 7 === 0)) { notFound.push(e); continue; }
      if (!players.some((p) => p.id === id)) players.push({ id, name: id === 3193 ? "Ryan M." : NAMES[id % NAMES.length], allowPushes: id % 4 !== 0, entry: e });
    }
    return { players, notFound };
  },
  test(id: number, t: { targetUserId?: number; targetEmail?: string } = {}): { pushId: number; devices: number; sent: number; failed: number } | { error: string } {
    seed();
    if (!store.has(id)) return { error: "That push no longer exists." };
    if (t.targetUserId === 28) return { error: "#28 has no phone signed in." };
    if (t.targetUserId && t.targetUserId % 7 === 0) return { error: `no account has the ID #${t.targetUserId}.` };
    return { pushId: 1, devices: 1, sent: 1, failed: 0 };
  },
  write(method: "POST" | "PATCH", path: string, body: Record<string, unknown> | undefined, email: string): { after: PushMessage } | { error: string } {
    seed();
    const m = /^\/admin\/push-notifications\/messages(?:\/(\d+))?(?:\/(send|pause|end))?$/.exec(path);
    if (!m) return { error: `The fixture has no ${method} ${path}.` };
    const b = body ?? {};
    const tapOf = (x: Record<string, unknown>, old?: PushMessage) => {
      const target = (x.tapTarget ?? old?.tap.target ?? "HOME") as PushMessage["tap"]["target"];
      return { target, effectiveTarget: target === "MATCH" ? target : "HOME" as const, matchId: target === "MATCH" ? ((x.tapMatchId ?? old?.tap.matchId ?? null) as number | null) : null, fieldId: target === "FIELD" ? ((x.tapFieldId ?? old?.tap.fieldId ?? null) as number | null) : null, match: null };
    };
    const fields = (x: Record<string, unknown>) => Object.fromEntries(["name", "audience", "holdoutPercent", "title", "body", "sendLocal"].filter((k) => k in x).map((k) => [k, x[k]]));
    if (method === "POST" && !m[1]) {
      const c = base(next++, String(b.name ?? ""), { ...fields(b), tap: tapOf(b), createdByStaffEmail: email, createdAt: new Date().toISOString(), audienceCount: null });
      store.set(c.id, c); return { after: c };
    }
    const c = store.get(Number(m[1]));
    if (!c) return { error: "That push no longer exists. Refresh the list." };
    const now = new Date().toISOString();
    const put = (x: PushMessage) => { const y = { ...x, group: groupOf(x.state), updatedAt: now }; store.set(y.id, y); return { after: y }; };
    if (m[2] === "send") {
      if (c.status === "LAUNCHED" || c.status === "ENDED") return { error: "It was already sent." };
      const cnt = fixture.count(c.audience, c.holdoutPercent);
      if (!c.sendLocal) RESULTS[c.id] = { targeted: cnt.matching, sent: cnt.willSend, failed: 0, opened: 0, openRate: 0, bookedWithin3Days: 0, bookingRate: 0, heldBack: cnt.heldBack, heldBackBooked: 0, heldBackBookingRate: 0, sentAt: now, launchedAt: now, launchedByStaffEmail: email };
      return put({ ...c, status: "LAUNCHED", state: c.sendLocal ? "SCHEDULED" : "SENT", queuedAt: now, launchedAt: now, launchedByStaffEmail: email, audienceCount: cnt.matching });
    }
    if (m[2] === "pause") return c.status === "LAUNCHED" ? put({ ...c, status: "PAUSED", state: "PAUSED" }) : { error: "Only a sent or scheduled push can be paused." };
    if (m[2] === "end") return c.status === "ENDED" ? { error: "It has already ended." } : put({ ...c, status: "ENDED", state: "ENDED", endedAt: now });
    return put({ ...c, ...fields(b), tap: "tapTarget" in b || "tapMatchId" in b || "tapFieldId" in b ? tapOf(b, c) : c.tap });
  },
  // The Offer results funnel (Figma 20864:72's numbers), shaped as the contract says.
  funnel(): FunnelPage {
    const f = (chosen: number, canGetIt: number, saw: number, used: number) => ({ chosen, canGetIt, canGetItPushesOn: Math.round(canGetIt / 3), estimated: true, snapshotAt: null, saw, used });
    const o = (id: number, name: string, fn: ReturnType<typeof f>) => ({ id, name, status: "LAUNCHED", state: "ENDED" as const, dealType: "PERCENT_OFF" as const, dealAmount: 50, launchedAt: iso(20), startsLocal: "2026-11-06 14:50:00", endsLocal: "2026-11-06 20:00:00", matchId: 20700 + id, endedAt: "2026-11-07T02:00:00.000Z", funnel: fn });
    return {
      from: iso(24 * 30), to: iso(0),
      totals: { chosen: 101, canGetIt: 28, canGetItPushesOn: 9, saw: 11, used: 0, offers: 3, estimatedOffers: 3 },
      planner: { used: 0, chosen: 101, useRate: 0, minUsed: 5, enoughData: false },
      offers: [o(40, "11/06 Bob Jones · 50% Discount (stand-in)", f(42, 12, 4, 0)), o(39, "11/06 Saginaw · 50% Discount (stand-in)", f(29, 9, 3, 0)), o(38, "11/06 Keswick Park · 50% Discount (stand-in)", f(30, 7, 4, 0))],
    };
  },
  withoutApp(id: number): WithoutApp { return { campaignId: id, count: 3, playerIds: [78 + id, 1481, 3193].slice(0, 3) }; },
};
