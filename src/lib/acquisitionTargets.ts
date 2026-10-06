// ACQUISITION TARGETS — the green / amber / red badges on the Acquisition page (Ryan, 2026-10-06).
// Change a number here and the page follows. Nothing else reads these.
//
//   Google rank            green at or better than `green`, amber up to `amber`, red worse
//   Cost per registration  green under `green`, amber up to `amber`, red over          (CENTS)
//   Click rate             green at or above `green`, amber from `amber`, red under    (fraction)

export const TARGETS = {
  googleRank: { green: 3, amber: 6 },
  costPerRegistrationCents: { green: 500, amber: 800 },
  clickRate: { green: 0.2, amber: 0.1 },
} as const;

export type Band = "green" | "amber" | "red";

/** Lower is better: rank 1 is the top of Google. */
export function rankBand(rank: number | null): Band | null {
  if (rank == null) return null;
  const t = TARGETS.googleRank;
  return rank <= t.green ? "green" : rank <= t.amber ? "amber" : "red";
}
export function cprBand(cents: number | null): Band | null {
  if (cents == null) return null;
  const t = TARGETS.costPerRegistrationCents;
  return cents < t.green ? "green" : cents <= t.amber ? "amber" : "red";
}
export function clickRateBand(rate: number | null): Band | null {
  if (rate == null) return null;
  const t = TARGETS.clickRate;
  return rate >= t.green ? "green" : rate >= t.amber ? "amber" : "red";
}
