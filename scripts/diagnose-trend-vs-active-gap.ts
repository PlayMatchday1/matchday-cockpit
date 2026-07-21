// Diagnose why MembershipTrendChart's cumulative net (Nov-May) doesn't
// match the MembershipActiveChart's active-count delta over the same
// window. Read-only.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import {
  isPaidExternalMember,
  isActiveAsOf,
  isCancelledInMonth,
  isNewInMonth,
  parseMemberDate,
  type MemberLike,
} from "../src/lib/membershipStats";

const env = readFileSync(
  "/Users/ryanmancuso/Code/matchday-cockpit/.env.local",
  "utf8",
);
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)![1].trim();
const key = env.match(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=(.+)/)![1].trim();
const sb = createClient(url, key);

async function main() {
  const members: MemberLike[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("fin_members")
      .select("status,price_cents,email,activation_date,canceled_at,city")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    members.push(...(data as MemberLike[]));
    if (data.length < 1000) break;
  }
  console.log(`Total fin_members: ${members.length}\n`);

  // Trend chart's 6-month window today (May 4 2026): Dec, Jan, Feb,
  // Mar, Apr, May 2026. Build the same buckets it does.
  const now = new Date();
  const months: Date[] = [];
  for (let i = 5; i >= 0; i--) {
    months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  }

  console.log("=== Trend chart buckets (paid-only filter) ===");
  console.log("month     | new | cancelled | net");
  console.log("----------|-----|-----------|----");
  let cumNew = 0;
  let cumCancel = 0;
  for (const m of months) {
    const newC = members.filter((mb) => isNewInMonth(mb, m)).length;
    const cancelC = members.filter((mb) => isCancelledInMonth(mb, m)).length;
    cumNew += newC;
    cumCancel += cancelC;
    const label = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
    console.log(
      `${label}   | ${String(newC).padStart(3)} | ${String(cancelC).padStart(9)} | ${newC - cancelC >= 0 ? "+" : ""}${newC - cancelC}`,
    );
  }
  console.log(`Cumulative: new=${cumNew}, cancelled=${cumCancel}, net=+${cumNew - cumCancel}\n`);

  // Active chart endpoints over same window.
  const startAsOf = new Date(months[0].getFullYear(), months[0].getMonth(), 0); // last day of month before first window month
  const endAsOf = now;
  const activeAtStart = members.filter((m) => isActiveAsOf(m, startAsOf)).length;
  const activeAtEnd = members.filter((m) => isActiveAsOf(m, endAsOf)).length;
  console.log(
    `Active-as-of ${startAsOf.toISOString().slice(0, 10)} (start of window): ${activeAtStart}`,
  );
  console.log(
    `Active-as-of ${endAsOf.toISOString().slice(0, 10)} (today): ${activeAtEnd}`,
  );
  console.log(`Active delta over window: ${activeAtEnd - activeAtStart >= 0 ? "+" : ""}${activeAtEnd - activeAtStart}\n`);

  console.log(
    `Gap to explain: trend-cumulative-net (${cumNew - cumCancel}) − active-delta (${activeAtEnd - activeAtStart}) = ${cumNew - cumCancel - (activeAtEnd - activeAtStart)}\n`,
  );

  // Hypothesis: members activated INSIDE the window but who later
  // canceled with explicit canceled_at OUTSIDE the window. Their
  // activation counts toward "new" in-window but their cancellation
  // doesn't count in any in-window "cancelled" bar — yet they're
  // not active by today either.
  const windowStart = months[0];
  const windowEndExclusive = new Date(
    months[months.length - 1].getFullYear(),
    months[months.length - 1].getMonth() + 1,
    1,
  );

  const activatedInWindow = members.filter((m) => {
    if (!isPaidExternalMember(m)) return false;
    const a = parseMemberDate(m.activation_date);
    return a !== null && a >= windowStart && a < windowEndExclusive;
  });
  console.log(`Members activated in window (paid-filter): ${activatedInWindow.length}`);

  const activatedInWindow_StillActive = activatedInWindow.filter((m) =>
    isActiveAsOf(m, endAsOf),
  );
  const activatedInWindow_Cancelled = activatedInWindow.filter(
    (m) => !isActiveAsOf(m, endAsOf),
  );
  console.log(
    `  …still active today: ${activatedInWindow_StillActive.length}`,
  );
  console.log(
    `  …no longer active today: ${activatedInWindow_Cancelled.length}`,
  );

  // Of the no-longer-active ones, how many had their cancellation
  // date IN the window vs OUTSIDE?
  const lostInWindow_CancelInWindow = activatedInWindow_Cancelled.filter(
    (m) => {
      const c = parseMemberDate(m.canceled_at);
      return c !== null && c >= windowStart && c < windowEndExclusive;
    },
  );
  const lostInWindow_CancelOutsideWindow = activatedInWindow_Cancelled.filter(
    (m) => {
      const c = parseMemberDate(m.canceled_at);
      return c !== null && (c < windowStart || c >= windowEndExclusive);
    },
  );
  const lostInWindow_NoCancelDate = activatedInWindow_Cancelled.filter(
    (m) => !parseMemberDate(m.canceled_at),
  );
  console.log(
    `    cancellation IN window (counted in cancelled bars): ${lostInWindow_CancelInWindow.length}`,
  );
  console.log(
    `    cancellation OUTSIDE window (NOT counted in cancelled bars): ${lostInWindow_CancelOutsideWindow.length}`,
  );
  console.log(
    `    no canceled_at at all (NOT counted): ${lostInWindow_NoCancelDate.length}`,
  );
  console.log();

  // Symmetric check: members who were active at start but lost
  // during the window, where the cancel happened outside the window
  // → would deflate cumulative_cancelled but they DID disappear
  // from active.
  const activeAtStartButNotEnd = members.filter(
    (m) => isActiveAsOf(m, startAsOf) && !isActiveAsOf(m, endAsOf),
  );
  console.log(
    `Members active at window start but NOT today: ${activeAtStartButNotEnd.length}`,
  );
  const lostFromExisting_CancelInWindow = activeAtStartButNotEnd.filter(
    (m) => {
      const c = parseMemberDate(m.canceled_at);
      return c !== null && c >= windowStart && c < windowEndExclusive;
    },
  );
  const lostFromExisting_CancelOutsideWindow = activeAtStartButNotEnd.filter(
    (m) => {
      const c = parseMemberDate(m.canceled_at);
      return c !== null && (c < windowStart || c >= windowEndExclusive);
    },
  );
  console.log(
    `  cancellation IN window: ${lostFromExisting_CancelInWindow.length}`,
  );
  console.log(
    `  cancellation OUTSIDE window: ${lostFromExisting_CancelOutsideWindow.length}`,
  );

  // Specific drill: December 2025 numbers per the user's spec.
  console.log("\n=== December 2025 specifics ===");
  const dec = new Date(2025, 11, 1);
  const decNew_paid = members.filter((m) => isNewInMonth(m, dec)).length;
  const decNew_unfiltered = members.filter((m) => {
    const a = parseMemberDate(m.activation_date);
    return (
      a !== null &&
      a.getFullYear() === 2025 &&
      a.getMonth() === 11
    );
  }).length;
  const decCancel_paid = members.filter((m) => isCancelledInMonth(m, dec)).length;
  const decCancel_unfiltered = members.filter((m) => {
    const c = parseMemberDate(m.canceled_at);
    return (
      c !== null &&
      c.getFullYear() === 2025 &&
      c.getMonth() === 11
    );
  }).length;
  console.log(
    `activation_date in Dec 2025, paid-filter:    ${decNew_paid}`,
  );
  console.log(
    `activation_date in Dec 2025, no filter:      ${decNew_unfiltered}`,
  );
  console.log(
    `canceled_at in Dec 2025, paid-filter:        ${decCancel_paid}`,
  );
  console.log(
    `canceled_at in Dec 2025, no filter:          ${decCancel_unfiltered}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
