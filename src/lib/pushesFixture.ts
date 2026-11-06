import "server-only";
// A STAND-IN for the Push Notifications backend, on a dev server only (PUSHES_FIXTURE=1; src/lib/pushesServer.ts
// refuses it under NODE_ENV=production or on Vercel). It exists so the screens can be built and looked at before the
// backend reaches staging. Everything here is made up, lives in this process's memory, and reaches no player and no
// change_log row. Delete it when the real contract lands and the server file is wired to it.

import type { AudienceBody, FoundPlayer, TokenLookup, Tokens } from "@/lib/audienceModel";
import type { PushCampaign, PushCount, PushResultsData } from "@/lib/pushesModel";

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
const base = (id: number, name: string, over: Partial<PushCampaign>): PushCampaign => ({
  id, name, title: "6 spots left Saturday at NEMP", body: "{first_name}, Sat 7:00 PM in Austin. Grab one before it fills.",
  tapTarget: "HOME", tapMatchId: null, tapFieldId: null, audienceMode: "FILTERS", filters: [{ key: "city", op: "isAnyOf", ids: [1] }], playerIds: [], holdoutPercent: 10,
  sendLocal: null, status: "DRAFT", queuedAt: null, sentAt: null, sentByStaffEmail: null, createdByStaffEmail: "rmancuso@playmatchday.com", updatedAt: iso(1), audienceSize: 946, results: null, ...over,
});
const store = new Map<number, PushCampaign>();
let next = 1;
function seed() {
  if (store.size) return;
  const rows: PushCampaign[] = [
    base(1, "Austin · Saturday NEMP fill", { status: "SENT", sentAt: iso(3), queuedAt: iso(3), sentByStaffEmail: "miguel@playmatchday.com", sentByStaffName: "Miguel Avendano", audienceSize: 946, results: { targeted: 946, sent: 880, opened: 74, bookedWithin3Days: 9, heldBack: 105, heldBackBooked: 2 } }),
    base(2, "Dallas Sunday reminder", { title: "Sunday pickup in Dallas", body: "{first_name}, there's a spot for you Sunday morning.", status: "SCHEDULED", sendLocal: "2026-11-08 09:00", queuedAt: iso(20), filters: [{ key: "city", op: "isAnyOf", ids: [2] }], audienceSize: 2010 }),
    base(3, "Members we miss", { title: "We miss you on the pitch", body: "{first_name}, your membership is waiting. Pick a match this week.", filters: [{ key: "membership", op: "is", choice: "MEMBER" }, { key: "lastPlayed", op: "moreThanDaysAgo", n: 30 }], audienceSize: null }),
    base(4, "October win-back", { status: "SENT", sentAt: iso(24 * 12), queuedAt: iso(24 * 12), sentByStaffEmail: "rmancuso@playmatchday.com", sentByStaffName: "Ryan Mancuso", audienceSize: 1284, results: { targeted: 1284, sent: 1051, opened: 88, bookedWithin3Days: 61, heldBack: 128, heldBackBooked: 4 } }),
    base(5, "Rained-out make-up", { status: "SENT", sentAt: iso(24 * 20), queuedAt: iso(24 * 20), sentByStaffEmail: "rmancuso@playmatchday.com", sentByStaffName: "Ryan Mancuso", audienceSize: 12, audienceMode: "PLAYERS", playerIds: [78, 1481, 3193, 2207, 4410, 11, 12, 13, 14, 15, 16, 17], holdoutPercent: 0, filters: [], results: { targeted: 12, sent: 11, opened: 6, bookedWithin3Days: 3, heldBack: 0, heldBackBooked: 0 } }),
    base(6, "Houston Thursday nudge", { status: "NOT_SENT", queuedAt: iso(24 * 30), filters: [{ key: "city", op: "isAnyOf", ids: [3] }, { key: "upcomingBooking", op: "no" }], audienceSize: 0 }),
  ];
  for (const r of rows) store.set(r.id, r);
  next = 7;
}

const NAMES = ["Ryan M.", "Diego R.", "Luis P.", "Sam K.", "Ana T.", "Marcus L.", "Priya N.", "Jordan W."];
const CITIES = ["Austin", "Dallas", "Houston", "San Antonio"];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export const fixture = {
  list(): PushCampaign[] { seed(); return [...store.values()]; },
  get(id: number): PushCampaign | null { seed(); return store.get(id) ?? null; },
  results(id: number): PushResultsData { seed(); return store.get(id)?.results ?? { targeted: 0, sent: 0, opened: 0, bookedWithin3Days: 0, heldBack: 0, heldBackBooked: 0 }; },
  count(body: AudienceBody): PushCount {
    if (body.audienceMode === "PLAYERS") { const n = body.playerIds.length; return { count: n, allowPush: Math.max(0, n - Math.floor(n / 5)), holdoutPercent: 0, heldBack: 0 }; }
    // Narrower with every filter, the same answer for the same filters.
    const h = hash(JSON.stringify(body.filters));
    const count = Math.max(0, Math.round(2600 / (1 + body.filters.length * 0.9)) - (h % 97));
    const allowPush = Math.round(count * 0.82);
    return { count, allowPush, holdoutPercent: 10, heldBack: Math.round(count * 0.1) };
  },
  sample(body: AudienceBody) {
    const c = fixture.count(body);
    const players = Array.from({ length: Math.min(25, c.count) }, (_, i) => ({ id: 100 + i * 37, name: NAMES[i % NAMES.length], city: CITIES[i % CITIES.length], allowsPush: i % 5 !== 4, lastPlayed: i % 3 === 0 ? null : `2026-${String(9 + (i % 2)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}` }));
    return { players, total: c.count };
  },
  lookup(t: Tokens): TokenLookup {
    const players: FoundPlayer[] = t.ids.filter((id) => id % 7 !== 0).map((id) => ({ id, name: NAMES[id % NAMES.length], city: CITIES[id % CITIES.length], allowsPush: id % 4 !== 0, token: String(id) }));
    for (const e of t.emails) if (e === "luis@example.com") players.push({ id: 4410, name: "Luis P.", city: "Austin", allowsPush: true, token: e });
    const found = new Set(players.map((p) => p.token));
    return { players, notFound: [...t.all.filter((x) => !found.has(x)), ...t.bad] };
  },
  test(id: number) { seed(); return store.has(id) ? { sent: 1, failed: 0 } : { sent: 0, failed: 1 }; },
  write(method: "POST" | "PATCH" | "DELETE", path: string, body: Record<string, unknown> | undefined, email: string): { after: PushCampaign | null } | { error: string } {
    seed();
    const m = /^\/admin\/pushes(?:\/(\d+))?(?:\/(send))?$/.exec(path);
    if (!m) return { error: `The fixture has no ${method} ${path}.` };
    const id = m[1] ? Number(m[1]) : null;
    if (method === "POST" && id === null) {
      const c = base(next++, String(body?.name ?? ""), { ...(body as Partial<PushCampaign>), status: "DRAFT", createdByStaffEmail: email, updatedAt: new Date().toISOString(), audienceSize: null, results: null });
      store.set(c.id, c); return { after: c };
    }
    const c = id === null ? null : store.get(id);
    if (!c) return { error: "That push no longer exists. Refresh the list." };
    if (method === "DELETE") { if (c.status !== "DRAFT") return { error: "Only a draft can be deleted." }; store.delete(c.id); return { after: null }; }
    if (m[2] === "send") {
      if (c.status !== "DRAFT") return { error: "It was already sent." };
      const count = fixture.count(c.audienceMode === "PLAYERS" ? { audienceMode: "PLAYERS", playerIds: c.playerIds } : { audienceMode: "FILTERS", filters: c.filters });
      const sent = Math.max(0, count.allowPush - count.heldBack);
      const now = new Date().toISOString();
      const after: PushCampaign = c.sendLocal
        ? { ...c, status: "SCHEDULED", queuedAt: now, updatedAt: now, audienceSize: count.count }
        : { ...c, status: "SENT", queuedAt: now, sentAt: now, sentByStaffEmail: email, updatedAt: now, audienceSize: count.count, results: { targeted: count.count, sent, opened: 0, bookedWithin3Days: 0, heldBack: count.heldBack, heldBackBooked: 0 } };
      store.set(c.id, after); return { after };
    }
    if (method === "PATCH") {
      if (c.status !== "DRAFT") return { error: "Only a draft can change." };
      const after = { ...c, ...(body as Partial<PushCampaign>), updatedAt: new Date().toISOString() };
      store.set(c.id, after); return { after };
    }
    return { error: `The fixture has no ${method} ${path}.` };
  },
};
