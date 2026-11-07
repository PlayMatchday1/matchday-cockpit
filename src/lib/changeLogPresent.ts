// CHANGE LOG 2.0 — how a stored change_log row becomes a row on the page (Figma 9TgSk4sYqq4nNoTH73wRRs,
// "Clubhouse · Change Log 2.0", 20860:45). PURE: no I/O, so scripts/change-log-2-test.ts asserts every
// rule on values. The server (src/lib/changeLogQuery.ts) supplies the names it looks up (Enrich).
//
// WHAT IT DECIDES (Ryan, 2026-11-07):
//   • Who: one identity per person, keyed on actor_email; first name and initials from
//     app_users.full_name. System actors get fixed names; the two script rows keep their own.
//   • Area: the kind of thing changed (Roster, Credits, Promo codes, …), from the endpoint first, the
//     source second. Source: where it was done (Player Lookup, Gameday Ops, …), from the source string.
//   • What happened: one plain sentence from the write, with the reason or the failure underneath.
//   • TEST: env = staging. Every staging row is a local test or a script (there is no staging
//     Clubhouse). Tagged, and left out of every count.
//   • Collapse: the same person, the same action, the same target, within a minute → one row "×N";
//     removals of the same player within a minute collapse across matches ("from N matches").
//
// TIME MODELS: created_at is a TRUE instant. A match's start_date (mdapi_matches) is LOCAL WALL CLOCK
// despite its Z — read off the string (wallClock), never through new Date().

import type { Change, LogEntry, LogState } from "@/lib/changeLogModel";

export type Enrich = {
  /** app_users, lower-cased email → full_name */
  staffByEmail: Record<string, string>;
  /** app_users id → { email, full_name } (for permission writes, whose target is a user id) */
  staffById: Record<string, { email: string; name: string | null }>;
  /** mdapi_users id → "First Last" */
  players: Record<string, string>;
  /** crm_threads id → the linked player's name, or null */
  threads: Record<string, string | null>;
  /** mdapi_matches api_id → field title, match name, WALL-CLOCK start */
  matches: Record<string, { field: string | null; name: string | null; start: string | null }>;
};
export const EMPTY_ENRICH: Enrich = { staffByEmail: {}, staffById: {}, players: {}, threads: {}, matches: {} };

// ── WHO ─────────────────────────────────────────────────────────────────────────────────────────
export type Actor = { key: string; name: string; initials: string; system: boolean };
const SYSTEM_ACTORS: [RegExp, string][] = [
  [/^auto-send(@clubhouse\.system)?$/i, "Auto-send"],
  [/^system \(out-of-hours auto-reply\)$/i, "Out-of-hours auto-reply"],
  [/^Field backfill\b/i, "Field backfill"],
  [/^Claude \(seeded by script/i, "Script"],
];
const initialsOf = (s: string) => {
  const w = s.trim().split(/[\s._-]+/).filter(Boolean);
  return ((w[0]?.[0] ?? "?") + (w[1]?.[0] ?? "")).toUpperCase();
};
export function actorOf(row: { actorName: string; actorEmail?: string | null }, en: Enrich): Actor {
  const raw = (row.actorName ?? "").trim();
  for (const [rx, name] of SYSTEM_ACTORS) if (rx.test(raw)) return { key: `system:${name}`, name, initials: initialsOf(name), system: true };
  const email = (row.actorEmail ?? (raw.includes("@") ? raw : "")).trim().toLowerCase();
  if (email) {
    const full = en.staffByEmail[email]?.trim();
    const first = full ? full.split(/\s+/)[0] : email.split("@")[0];
    return { key: email, name: first, initials: full ? initialsOf(full) : initialsOf(email.split("@")[0]), system: false };
  }
  return { key: `name:${raw.toLowerCase()}`, name: raw || "Unknown", initials: initialsOf(raw || "?"), system: false };
}

// ── AREA and SOURCE ─────────────────────────────────────────────────────────────────────────────
export const AREAS = [
  "Roster", "Credits", "Promo codes", "Matches", "Memberships", "Chats", "Strikes", "Staff access",
  "Fields", "Offers & pushes", "Pricing", "Growth", "Lapsed spots", "Syncs", "Other",
] as const;
export type Area = (typeof AREAS)[number];

const ep = (e: string) => e.replace(/#.*$/, "");
export function areaOf(r: { source: string; env: string; method: string; endpoint: string; changes?: Change[] }): Area {
  const s = r.source, e = ep(r.endpoint);
  if (r.env === "prod" || /^(stripe-people-sync|fin-txn-sync)$/.test(s) || /^Finance · fin_txn/.test(s) || e.startsWith("/api/sync/")) return "Syncs";
  if (/^Lapsed spots/i.test(s)) return "Lapsed spots";
  if (/^Apply .*ladder/i.test(s)) return "Pricing";
  if (/^Growth/i.test(s)) return "Growth";
  if (e.startsWith("/admin/promocodes")) return "Promo codes";
  if (/^\/admin\/(offers|push-notifications)/.test(e) || /^(offers|pushes):/.test(s)) return "Offers & pushes";
  if (e.startsWith("/admin/strikes")) return "Strikes";
  if (e.startsWith("/admin/subscriptions")) return "Memberships";
  if (/^\/api\/(crm|whatsapp)\//.test(e) || e.startsWith("/crm/") || /^crm-/.test(s)) return "Chats";
  if (/^\/admin\/players\/\d+\/profile$/.test(e)) return (r.changes ?? []).some((c) => c.key === "creditAmount") ? "Credits" : "Other";
  if (/^Match panel · (teams|reduce|convert|team size)/.test(s)) return "Roster";
  if (/^\/admin\/(matches\/user-matches|user-matches)/.test(e) || /^\/admin\/matches\/\d+\/(players|fake-players|batch\/fake-players)/.test(e)) return "Roster";
  if (/^\/admin\/matches(\/\d+)?(\/cancel|\/cover)?$/.test(e)) return "Matches";
  if (/^\/admin\/users\//.test(e) || e.startsWith("/app_users") || e.startsWith("/city-managers") || e.startsWith("/api/app/view-as")
    || /^(User admin|Admin · User access|City manager|Match managers)/.test(s)) return "Staff access";
  if (/^\/admin\/fields/.test(e) || e.startsWith("/fin_venue_fields") || /^(Fields|Admin · Fields|Venues & Fields|Match Ops · Fields|Field covers|Veo)/.test(s)) return "Fields";
  return "Other";
}

const SOURCE_LABELS: [RegExp, string][] = [
  [/^(player-lookup|Player Lookup( · credits)?|Player Lookup — Stripe check|Player export)$/, "Player Lookup"],
  [/^(Match panel|gameday-)/, "Gameday Ops"],
  [/^(Master Schedule|Copy match$)/, "Master Schedule"],
  [/^Match editor/, "Match editor"],
  [/^Player Chats · draft action$/, "Player Chats · suggested reply"],
  [/^(crm-auto-send|crm-human-push|Player Chats · auto-send)$/, "Auto-send"],
  [/^Staff app( · |$)/, "Staff app"],
  [/^(User admin|Admin · User access|City manager|Match managers)/, "User admin"],
  [/^Promo Codes$/, "Promo Codes"],
  [/^offers:/, "Offers"],
  [/^pushes:/, "Push Notifications"],
  [/^Lapsed spots$/, "Lapsed Spots"],
  [/^Apply .*ladder$/, "Pricing ladder"],
  [/^(Fields|Admin · Fields|Venues & Fields|Match Ops · Fields|Field covers|Veo)/, "Fields"],
  [/^stripe-people-sync$/, "Stripe sync"],
  [/^fin-txn-sync$/, "Finance sync"],
  [/^Finance · fin_txn/, "Finance backfill"],
  [/^Growth/, "Growth"],
  [/^Manager Pay/, "Manager Pay"],
  [/^Partner Dashboards/, "Partner Dashboards"],
  [/^Field economics/, "Field economics"],
  [/^Migration/, "Migration"],
  [/(proof|test|^check:|^e2e-|^staging verification)/i, "Test run"],
];
export function sourceLabelOf(r: { source: string; actorName?: string }): string {
  if (r.source === "crm-send") {
    if (/out-of-hours/i.test(r.actorName ?? "")) return "Out-of-hours auto-reply";
    if (/^auto-send/i.test(r.actorName ?? "")) return "Auto-send";
    return "Player Chats";
  }
  for (const [rx, label] of SOURCE_LABELS) if (rx.test(r.source)) return label;
  return r.source;
}

export const isTest = (r: { env: string }) => r.env === "staging";

// ── HOW THINGS ARE NAMED ────────────────────────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** WALL CLOCK "Sat, Nov 7 · 9:00 AM", read off the string. */
export function wallClock(start: string | null | undefined): string {
  const x = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(start ?? "");
  if (!x) return "";
  const [, y, mo, d, hh, mi] = x;
  const h = +hh;
  return `${WEEKDAYS[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()]}, ${MONTHS[+mo - 1]} ${+d} · ${h % 12 === 0 ? 12 : h % 12}:${mi} ${h >= 12 ? "PM" : "AM"}`;
}
const cleanName = (s: string | null | undefined) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
export function matchOf(e: { matchId: number | null; matchName: string | null }, en: Enrich) {
  const m = e.matchId != null ? en.matches[String(e.matchId)] : undefined;
  const field = cleanName(m?.field) || cleanName(e.matchName) || cleanName(m?.name) || (e.matchId != null ? `match ${e.matchId}` : "");
  return { field, when: wallClock(m?.start ?? null) };
}
const idIn = (e: string, rx: RegExp) => rx.exec(e)?.[1] ?? null;
const dollars = (c: number) => `$${(Math.abs(c) / 100).toFixed(2)}`;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);
const str = (v: unknown) => (v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const LABELS: Record<string, string> = {
  name: "name", fieldId: "field", managerId: "manager", secondManagerId: "second manager", registrationPrice: "price",
  additionalSpotPrice: "spot price", guestCount: "guest count", category: "category", type: "type",
  minPlayerCount: "minimum players", maxPlayerCount: "capacity", maxTeamSize2Team: "total as 2 teams",
  maxTeamSize4Team: "total as 4 teams", isAutoBump: "auto-bump", autoCanceled: "auto-cancel",
  autoCanceledMinutes: "auto-cancel minutes", isFreeMember: "free for members", description: "description",
  startDate: "start", endDate: "end", locked: "lock", fakeSpotLeft3h: "3h fake spots", fakeSpotLeft6h: "6h fake spots",
  fakeSpotLeft12h: "12h fake spots", fakeSpotLeft24h: "24h fake spots", fakeSpotLeft36h: "36h fake spots",
};
const MONEY_KEYS = new Set(["registrationPrice", "additionalSpotPrice"]);
const val = (k: string, v: unknown) => {
  // startDate / endDate are WALL CLOCK: read off the string, never shifted.
  if ((k === "startDate" || k === "endDate") && typeof v === "string" && wallClock(v)) return wallClock(v);
  if (MONEY_KEYS.has(k) && num(v) != null) { const n = num(v)!; return `$${n % 100 === 0 ? n / 100 : (n / 100).toFixed(2)}`; }
  if (typeof v === "boolean") return v ? "on" : "off";
  return str(v);
};

// ── FAILURE IN PLAIN WORDS ──────────────────────────────────────────────────────────────────────
export function matchdaySaid(serverSaid: string | null | undefined): { status: number | null; code: string | null } {
  const s = serverSaid ?? "";
  const status = /HTTP (\d{3})/.exec(s)?.[1] ?? /"statusCode\\?":\s*(\d{3})/.exec(s)?.[1] ?? null;
  const code = /"errorCode\\?":\s*\\?"([A-Z0-9_]+)/.exec(s)?.[1] ?? null;
  return { status: status ? Number(status) : null, code };
}
const PLAIN_CODES: Record<string, string> = {
  PROMOCODE_START_DATE_PASSED: "the start date was already in the past",
};
export function failureWords(outcome: LogState, serverSaid: string | null | undefined): string | null {
  if (outcome === "unknown") return "MatchDay never answered, so it may or may not have happened.";
  if (outcome === "notapplied") return "MatchDay accepted it, but a re-read shows nothing changed.";
  if (outcome !== "failed") return null;
  const { status, code } = matchdaySaid(serverSaid);
  if (code && PLAIN_CODES[code]) return `MatchDay refused it: ${PLAIN_CODES[code]}.`;
  if (code) return `MatchDay refused it (${code.toLowerCase().replace(/_/g, " ")}).`;
  if (status) return `MatchDay refused it (HTTP ${status}).`;
  return serverSaid ? `It failed: ${serverSaid.split("\n")[0].slice(0, 140)}` : "It failed.";
}

// ── WHAT HAPPENED ───────────────────────────────────────────────────────────────────────────────
export type Kind = "remove" | "add" | "move" | "credit" | "promo" | "other";
export type Described = { kind: Kind; what: string; sub: string | null; player: string | null; link: { href: string; label: string } | null };

export function describe(e: LogEntry, en: Enrich): Described {
  const endpoint = ep(e.endpoint), ch = e.changes ?? [], body = e.body ?? {};
  const m = matchOf(e, en);
  const failed = e.outcome === "failed";
  const matchLink = e.matchId != null ? { href: `/match-ops/match-panel/${e.matchId}`, label: "Open the match ›" } : null;
  const at = m.field ? ` at ${m.field}` : "";
  const find = (k: string) => ch.find((c) => c.key === k);

  // Roster
  const rem = find("remove");
  if (e.method === "DELETE" && /^\/admin\/matches\/user-matches\/\d+$/.test(endpoint) && rem) {
    const player = typeof rem.before === "string" && rem.before !== "—" ? rem.before : "a player";
    return { kind: "remove", what: `${failed ? "Tried to remove" : "Removed"} ${player} from ${m.field || "a match"}`, sub: m.when || null, player, link: matchLink };
  }
  if (e.method === "DELETE" && /^\/admin\/matches\/user-matches\//.test(endpoint)) {
    const n = Array.isArray(body.removes) ? body.removes.length : e.requests;
    return { kind: "other", what: `Removed ${n} fake player${n === 1 ? "" : "s"}${at}`, sub: m.when || null, player: null, link: matchLink };
  }
  const shape = ch.find((c) => /:shape$/.test(c.key));
  if (shape) return { kind: "other", what: `${shape.field}${at}`, sub: `${str(shape.before)} → ${str(shape.after)}`, player: null, link: matchLink };
  const pid = idIn(endpoint, /^\/admin\/matches\/\d+\/players\/(\d+)$/);
  if (e.method === "POST" && pid) {
    const player = en.players[pid] ?? `player ${pid}`;
    return { kind: "add", what: `Added ${player} to ${m.field || "a match"}`, sub: [m.when, find("add") ? `as ${str(find("add")!.after)}` : null].filter(Boolean).join(" · ") || null, player, link: matchLink };
  }
  const mv = find("move");
  if (endpoint === "/admin/user-matches" && mv) {
    return { kind: "move", what: `Moved a player${at} to ${str(mv.after)}`, sub: [m.when, `from ${str(mv.before)}`].filter(Boolean).join(" · "), player: null, link: matchLink };
  }
  const fk = find("fakes");
  if (fk) return { kind: "other", what: `Set fake players${at} from ${str(fk.before)} to ${str(fk.after)}`, sub: m.when || null, player: null, link: matchLink };

  // Credits
  const cr = find("creditAmount");
  const profileId = idIn(endpoint, /^\/admin\/players\/(\d+)\/profile$/);
  if (cr && profileId) {
    const player = en.players[profileId] ?? `player ${profileId}`;
    const delta = (num(cr.after) ?? 0) - (num(cr.before) ?? 0);
    const verb = delta >= 0 ? (failed ? "Tried to give" : "Gave") : failed ? "Tried to take" : "Took";
    const reason = find("reason")?.after;
    return { kind: "credit", what: `${verb} ${dollars(delta)} credit ${delta >= 0 ? "to" : "from"} ${player}`, sub: reason && reason !== "—" ? `Reason: ${str(reason)}` : null, player, link: { href: `/match-ops/player-lookup?id=${profileId}`, label: "Open in Player Lookup ›" } };
  }

  // Promo codes
  if (endpoint === "/admin/promocodes" && e.method === "POST") {
    const code = typeof body.code === "string" ? body.code : e.matchName ?? "a code";
    const pct = body.discountType === "PERCENT" ? `${body.discountValue}% off` : num(body.discountValue) != null ? `${dollars(num(body.discountValue)!)} off` : null;
    const who = body.targetUserType === "ALL_USERS" ? "all players" : body.targetUserType === "NEW_USERS" ? "new players" : body.targetUserType === "SPECIFIC_USERS" ? "specific players" : null;
    return { kind: "promo", what: `${failed ? "Tried to create" : "Created"} promo code ${code}`, sub: [pct, who].filter(Boolean).join(", ") || null, player: null, link: { href: "/match-ops/promos", label: "Open in Promo Codes ›" } };
  }

  // Matches
  if (e.method === "PATCH" && /^\/admin\/matches\/\d+\/cancel$/.test(endpoint)) {
    const reason = find("reason")?.after;
    return { kind: "other", what: `Cancelled ${m.field || "a match"}`, sub: [m.when, reason && reason !== "" ? `Reason: ${str(reason).slice(0, 90)}` : null].filter(Boolean).join(" · ") || null, player: null, link: matchLink };
  }
  if (e.method === "DELETE" && /^\/admin\/matches\/\d+$/.test(endpoint)) return { kind: "other", what: `Deleted ${m.field || "a match"}`, sub: m.when || null, player: null, link: null };
  if (e.method === "POST" && endpoint === "/admin/matches") return { kind: "other", what: `Created ${m.field || "a match"}`, sub: m.when || null, player: null, link: matchLink };
  if (e.method === "PUT" && /^\/admin\/matches\/\d+$/.test(endpoint) && ch.length) {
    const c = ch[0];
    const label = LABELS[c.key] ?? c.field ?? c.key;
    return { kind: "other", what: `Changed ${m.field || "a match"}${m.when ? ` ${m.when.replace(/^\w+, /, "").replace(" · ", " ")}` : ""} ${label} from ${val(c.key, c.before)} to ${val(c.key, c.after)}`, sub: ch.length > 1 ? `and ${ch.length - 1} more change${ch.length - 1 === 1 ? "" : "s"}` : null, player: null, link: matchLink };
  }

  // Chats
  const threadId = typeof body.thread_id === "string" ? body.thread_id : null;
  const chatPlayer = threadId ? en.threads[threadId] ?? (body.recipient_last4 ? `…${body.recipient_last4}` : "a player") : null;
  const chatLink = threadId ? { href: `/match-ops/player-chats?threadId=${threadId}`, label: "Open the chat ›" } : null;
  if (endpoint === "/api/crm/send" || endpoint === "/api/whatsapp/webhook" || endpoint === "/api/crm/send-media" || endpoint === "/api/crm/send-template") {
    const auto = body.auto_reply === true || /auto-reply/.test(str(ch[0]?.after));
    const what = auto ? `Sent an automatic reply to ${chatPlayer}` : endpoint.endsWith("media") ? `Sent a file to ${chatPlayer}` : endpoint.endsWith("template") ? `Sent a WhatsApp template to ${chatPlayer}` : `Sent a message to ${chatPlayer}`;
    const len = num(body.message_length);
    return { kind: "other", what, sub: auto ? "Out-of-hours message" : [body.channel === "whatsapp" ? "WhatsApp" : body.channel === "sms" ? "SMS" : null, len != null ? `${len} characters` : null].filter(Boolean).join(" · ") || null, player: chatPlayer, link: chatLink };
  }
  if (endpoint.startsWith("/crm/human-push/")) {
    const reason = str(ch[0]?.after);
    return { kind: "other", what: endpoint.endsWith("/escalate") ? `Escalated ${chatPlayer ?? "a chat"} to the city's staff` : `Asked a person to reply to ${chatPlayer ?? "a chat"}`, sub: reason !== "—" ? reason : null, player: chatPlayer, link: chatLink };
  }
  if (endpoint === "/api/crm/auto-send/config") return { kind: "other", what: "Changed the auto-send settings", sub: ch.map((c) => `${c.field}: ${str(c.before)} → ${str(c.after)}`).join(" · ").slice(0, 160) || null, player: null, link: null };

  // Strikes, memberships
  if (endpoint.startsWith("/admin/strikes/")) {
    const uid = num(body.userId);
    const player = uid != null ? en.players[String(uid)] ?? `player ${uid}` : "a player";
    return { kind: "other", what: `Removed a strike from ${player}`, sub: ch[0] ? `${str(ch[0].before)} → ${str(ch[0].after)}` : null, player, link: uid != null ? { href: `/match-ops/player-lookup?id=${uid}`, label: "Open in Player Lookup ›" } : null };
  }
  if (endpoint.startsWith("/admin/subscriptions/")) {
    const uid = idIn(endpoint, /\/users\/(\d+)/) ?? (num(body.userId) != null ? String(num(body.userId)) : null);
    const player = uid ? en.players[uid] ?? `player ${uid}` : "a member";
    const what = /unsubscribe/.test(endpoint) ? `Cancelled ${player}'s membership` : /\/free$/.test(endpoint) ? `Gave ${player} a free membership` : `Changed ${player}'s membership`;
    return { kind: "other", what, sub: /stripe-verify/.test(e.endpoint) ? "Stripe check" : null, player, link: uid ? { href: `/match-ops/player-lookup?id=${uid}`, label: "Open in Player Lookup ›" } : null };
  }

  // Staff access
  const userId = idIn(endpoint, /^\/(?:admin\/users|app_users)\/([0-9a-f-]{36})/);
  if (userId) {
    const who = en.staffById[userId]?.name ?? en.staffById[userId]?.email ?? "a staff account";
    if (e.method === "DELETE") return { kind: "other", what: `Deleted ${who}'s account`, sub: null, player: null, link: null };
    const flips = ch.filter((c) => typeof c.after === "boolean").map((c) => `${c.field.replace(/^can_/, "").replace(/_/g, " ")} ${c.after ? "on" : "off"}`);
    if (flips.length) return { kind: "other", what: `Changed ${who}'s permissions`, sub: flips.join(" · "), player: null, link: null };
    if (find("phone_last4")) return { kind: "other", what: `Set ${who}'s phone`, sub: `ends ${str(find("phone_last4")!.after)}`, player: null, link: null };
  }
  if (endpoint === "/api/app/view-as") return { kind: "other", what: e.method === "DELETE" ? "Stopped viewing the app as someone else" : "Viewed the app as someone else", sub: ch[0] ? str(ch[0].after) : null, player: null, link: null };

  // Offers & pushes
  const offerName = typeof body.name === "string" ? body.name : null;
  if (/^\/admin\/offers\/campaigns/.test(endpoint)) {
    const id = idIn(endpoint, /campaigns\/(\d+)/);
    const verb = /\/launch$/.test(endpoint) ? "Launched" : /\/end$/.test(endpoint) ? "Ended" : /\/push\/test$/.test(endpoint) ? "Sent a test push for" : /\/push$/.test(endpoint) ? "Set the push for" : e.method === "DELETE" ? "Deleted" : e.method === "POST" ? "Created" : "Edited";
    return { kind: "other", what: `${verb} offer ${offerName ?? (id ? `#${id}` : "")}`.trim(), sub: null, player: null, link: { href: "/match-ops/offers", label: "Open in Offers ›" } };
  }
  if (/^\/admin\/push-notifications/.test(endpoint)) {
    const id = idIn(endpoint, /messages\/(\d+)/);
    const verb = /\/send$/.test(endpoint) ? "Sent" : /\/end$/.test(endpoint) ? "Ended" : /\/test$/.test(endpoint) ? "Sent a test of" : e.method === "POST" ? "Created" : "Edited";
    return { kind: "other", what: `${verb} push ${offerName ?? (id ? `#${id}` : "")}`.trim(), sub: null, player: null, link: { href: "/match-ops/push-notifications", label: "Open in Push Notifications ›" } };
  }

  // Anything else: the first change, plainly.
  const c = ch[0];
  if (c) return { kind: "other", what: `${c.field || c.key}${at}: ${str(c.before).slice(0, 60)} → ${str(c.after).slice(0, 60)}`, sub: ch.length > 1 ? `and ${ch.length - 1} more change${ch.length - 1 === 1 ? "" : "s"}` : null, player: null, link: matchLink };
  return { kind: "other", what: `${e.method} ${e.endpoint}${at}`, sub: null, player: null, link: matchLink };
}

// ── COLLAPSE ────────────────────────────────────────────────────────────────────────────────────
export const COLLAPSE_MS = 60_000;
export type Presented = {
  entry: LogEntry; actor: Actor; area: Area; source: string; test: boolean; sync: boolean; described: Described;
};
const RANK: Record<LogState, number> = { unknown: 3, notapplied: 2, failed: 1, landed: 0 };
export type Item = {
  id: string; at: string; actor: Actor; area: Area; source: string; test: boolean; sync: boolean;
  what: string; sub: string | null; failure: string | null; outcome: LogState; needs: boolean;
  /** "×N in 1 min" for identical writes; null otherwise (a cross-match removal says N in its sentence). */
  pill: string | null;
  members: Presented[]; link: { href: string; label: string } | null;
};
const unresolved = (e: LogEntry) => (e.outcome === "unknown" || e.outcome === "notapplied") && !e.resolved;
const sig = (p: Presented) => `${p.entry.method} ${p.entry.endpoint} ${JSON.stringify(p.entry.changes)} ${p.entry.outcome}`;

/** Newest first in, newest first out. Same person and, within a minute of the group's newest write:
 *  identical writes (same method, endpoint, changes, outcome) collapse to "×N"; removals of the same
 *  player collapse across matches ("Removed X from N matches"). */
export function collapse(ps: readonly Presented[], en: Enrich): Item[] {
  const out: Item[] = [];
  const used = new Set<number>();
  for (let i = 0; i < ps.length; i++) {
    if (used.has(i)) continue;
    const head = ps[i];
    const group = [head];
    const t0 = Date.parse(head.entry.at);
    const isRem = head.described.kind === "remove" && !!head.described.player && head.described.player !== "a player";
    for (let j = i + 1; j < ps.length; j++) {
      if (used.has(j)) continue;
      const p = ps[j];
      if (t0 - Date.parse(p.entry.at) > COLLAPSE_MS) break;
      if (p.actor.key !== head.actor.key || p.test !== head.test) continue;
      const same = isRem
        ? p.described.kind === "remove" && p.described.player === head.described.player && p.entry.outcome === head.entry.outcome
        : sig(p) === sig(head);
      if (same) { group.push(p); used.add(j); }
    }
    used.add(i);
    const outcome = group.reduce<LogState>((w, p) => (RANK[p.entry.outcome] > RANK[w] ? p.entry.outcome : w), "landed");
    let what = head.described.what, sub = head.described.sub, pill: string | null = null;
    const distinctMatches = new Set(group.map((p) => p.entry.matchId));
    if (group.length > 1 && isRem && distinctMatches.size > 1) {
      const fields = new Set(group.map((p) => matchOf(p.entry, en).field));
      what = `${head.entry.outcome === "failed" ? "Tried to remove" : "Removed"} ${head.described.player} from ${group.length} matches${fields.size === 1 ? ` at ${[...fields][0]}` : ""}`;
      sub = group.map((p) => matchOf(p.entry, en).when).filter(Boolean).join("; ") || null;
    } else if (group.length > 1) {
      pill = `×${group.length} in 1 min`;
    }
    out.push({
      id: head.entry.saveId, at: head.entry.at, actor: head.actor, area: head.area, source: head.source, test: head.test, sync: head.sync,
      what, sub, failure: failureWords(outcome, group.find((p) => p.entry.serverSaid)?.entry.serverSaid), outcome,
      needs: group.some((p) => unresolved(p.entry)), pill, members: group, link: head.described.link,
    });
  }
  return out;
}

/** emailBySave: the actor_email of each save (LogEntry carries the name only). */
export function present(entries: readonly LogEntry[], en: Enrich, emailBySave: Record<string, string | null> = {}): Presented[] {
  return entries.map((entry) => {
    const area = areaOf(entry);
    return {
      entry, actor: actorOf({ actorName: entry.actorName, actorEmail: emailBySave[entry.saveId] ?? null }, en), area, source: sourceLabelOf(entry), test: isTest(entry), sync: area === "Syncs",
      described: describe(entry, en),
    };
  });
}

/** What search matches: every word a person would type to find the row. */
export const searchText = (it: Item) =>
  [it.what, it.sub, it.failure, it.actor.name, it.actor.key, it.area, it.source,
    ...it.members.flatMap((p) => [p.entry.matchName, p.described.player, typeof p.entry.body?.code === "string" ? p.entry.body.code : null, p.entry.matchId != null ? String(p.entry.matchId) : null])]
    .filter(Boolean).join(" ").toLowerCase();

/** Copy details for engineering: everything needed to chase it, no message bodies (change_log never holds them). */
export function engineeringText(it: Item): string {
  const lines = [`Change Log · ${it.what}`, `who: ${it.actor.key} · area: ${it.area} · source: ${it.source} · result: ${it.outcome}${it.test ? " · TEST (staging)" : ""}`];
  for (const p of it.members) {
    const e = p.entry;
    lines.push("", `save ${e.saveId} · ${e.at} · env ${e.env}`, `${e.method} ${e.endpoint} → ${e.outcome}${e.requests > 1 ? ` (${e.landedN} of ${e.requests} landed)` : ""}`);
    if (e.serverSaid) lines.push(`matchday said: ${e.serverSaid}`);
    if (e.changes.length) lines.push(`changes: ${JSON.stringify(e.changes)}`);
    if (Object.keys(e.body ?? {}).length) lines.push(`body: ${JSON.stringify(e.body)}`);
  }
  return lines.join("\n");
}
