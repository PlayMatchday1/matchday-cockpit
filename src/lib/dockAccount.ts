// The account facts the DOCKED player chat shows, and the canned lines it offers.
//
// WHY THIS IS A FILE AND NOT TWENTY LINES INSIDE CrmDock. Two of its rules are the kind that read
// as obviously right and are wrong in one direction only:
//
//   - a snippet must never state a membership fact for a player who has no membership, and
//   - a snippet must never state a cancellation for a player who has not cancelled.
//
// Both failures put a false sentence in an operator's draft, one keystroke from being sent to a
// player. A pure function is something a test can prove; a JSX expression is something a screenshot
// can only fail to disprove. See scripts/dock-account-test.ts.
//
// Nothing here fetches. CrmDock hands it the parsed /api/lookup/{env}?id= payload — the SAME route
// and the SAME numbers Player Lookup renders, so the strip in the dock cannot drift from the page
// it is a shortcut to.

import { money } from "@/lib/playerLookupModel";

export type DockMembership = {
  status: string;
  /** The moment the player pressed cancel — a TRUE instant, unlike MatchDay's wall-clock fields. */
  canceledAt: string | null;
  /** currentPeriodEnd: what they have already paid through. */
  renews: string | null;
  /** Cents. */
  price: number | null;
};

export type DockAccount = {
  playerId: number;
  name: string;
  city: string | null;
  level: number | null;
  played: number;
  upcoming: number;
  /** Cents. */
  credits: number;
  strikes: number;
  strikeLimit: number;
  membership: DockMembership | null;
};

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Narrow the lookup profile payload to what the dock shows. Returns null on any unusable shape. */
export function accountFromProfile(raw: unknown): DockAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const p = j.player as Record<string, unknown> | undefined;
  if (!p || typeof p.id !== "number") return null;
  const st = j.strikes as Record<string, unknown> | undefined;
  const m = j.membership as Record<string, unknown> | null | undefined;
  return {
    playerId: p.id,
    name: s(p.name) ?? `ID ${p.id}`,
    city: s(p.city),
    level: typeof p.level === "number" ? p.level : null,
    played: n(p.matchesPlayed),
    upcoming: n(p.upcoming),
    credits: n(p.credits),
    strikes: n(st?.activeCount),
    // Never default the limit to 0 — "0/0 strikes" reads as a suspended player.
    strikeLimit: n(st?.limit) || 4,
    membership: m
      ? {
          status: s(m.status) ?? "",
          canceledAt: s(m.canceledAt),
          renews: s(m.renews),
          price: typeof m.price === "number" ? m.price : null,
        }
      : null,
  };
}

/* America/Chicago, DST-aware, for the values that are true instants. The membership card makes the
 * same choice for the same reason: 35.1% of the cancellation timestamps in mdapi_subscriptions
 * print a different DAY in UTC than in Central, and one of them straddles a billing month. */
const day = (iso: string | null, tz: string): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
};
export const cancelDay = (iso: string | null) => day(iso, "America/Chicago");
/** currentPeriodEnd is a period BOUNDARY (…T04:59:59Z = the last second of the month in Central),
 *  so it is printed as the boundary date the API and Stripe both name, exactly as the card does. */
export const periodDay = (iso: string | null) => day(iso, "UTC");

/** True while a cancelled membership is still inside the period it was paid for. */
export function stillRunning(m: DockMembership | null, nowMs = Date.now()): boolean {
  if (!m?.canceledAt || !m.renews) return false;
  const t = Date.parse(m.renews);
  return Number.isFinite(t) && t > nowMs;
}

/** The billing line under the identity strip — null when there is nothing worth saying. */
export function billingLine(a: DockAccount | null, nowMs = Date.now()): string | null {
  const m = a?.membership;
  if (!m) return null;
  const amount = m.price != null ? ` · ${money(m.price)}` : "";
  if (m.canceledAt && stillRunning(m, nowMs)) {
    return `Cancelled ${cancelDay(m.canceledAt)}, runs to ${periodDay(m.renews)}${amount}`;
  }
  if (m.canceledAt) return `Cancelled ${cancelDay(m.canceledAt)}${amount}`;
  if (m.renews) return `Renews ${periodDay(m.renews)}${amount}`;
  return null;
}

/* ── THE CANNED LINES, KEYED OFF THE CONVERSATION INSTEAD OF THE SCREEN ────────────────────────
 * They came from dockSubject.snippets, which is per SCREEN. That is why a player asking for a
 * refund was offered "Which city are you playing in?" on a panel that already knew they were in
 * San Antonio — the lines belonged to Player Lookup, not to the person writing.
 *
 * A LINE THAT STATES A FACT IS ONLY OFFERED WHEN THE FACT IS LOADED AND TRUE. Everything below
 * either comes from `a`, or says nothing specific. A snippet still only ever INSERTS into the
 * draft; nothing here sends. */
export function dockSnippets(a: DockAccount | null, opts?: { canSend?: boolean }): string[] {
  if (opts?.canSend === false) return [];
  const out: string[] = [];
  const m = a?.membership ?? null;

  if (m?.canceledAt) {
    out.push(
      stillRunning(m)
        ? `Your membership was cancelled on ${cancelDay(m.canceledAt)} and runs to ${periodDay(m.renews)}.`
        : `Your membership was cancelled on ${cancelDay(m.canceledAt)}.`,
    );
    out.push("Nothing further will be charged.");
  } else if (m) {
    if (m.renews) out.push(`Your membership renews on ${periodDay(m.renews)}.`);
  }

  if (a && a.credits > 0) out.push(`You have ${money(a.credits)} in credits on your account.`);

  // Always safe: neither states a fact about the account.
  out.push("I'm looking at your account now.");
  if (!a) out.push("Can you confirm the email on your account?");
  return out;
}
