// City P&L — one computed row per city for the ranked Finance table.
//
// THE UNMAPPED-COST RULE (the point of the exercise): a field whose cost basis
// we don't know (canonicalVenueCost kind "unknown" or "needs_override") is a
// field we cannot net, NOT a field that costs zero. Its DPP revenue is held OUT
// of DPP rev and Field net entirely and surfaced separately as `untracked`.
//
//   DPP rev    = DPP at fields whose cost basis is KNOWN, for the period
//   Field net  = DPP rev − field cost, at those same known-cost fields only
//   Overhead   = the 5 overhead categories (NO field cost — it's inside Field net)
//   Net P&L    = Field net + Member rev − Overhead
//   Margin     = Net P&L / (DPP rev + Member rev)
//
// Profit-share fields (Crossbar Rowlett: per_match_minus_manager / profit_share)
// are mapped: their cost is the partner-dashboard amount owed, never "N × $0".

import type { FinanceData } from "@/lib/useFinanceData";
import type { JoinedMatchPlayerRow } from "@/lib/mdapiMatchesRead";
import {
  cityMembershipRevenueFor,
  cityOverheadFor,
  cityTotalMemberSpotsFor,
  groupPerMatchCostFor,
  groupPerMatchCostRealizedFor,
  venueMemberSpotsFor,
  venuePartnerRevenueFor,
  venueRealizedCostFor,
  type Q2Month,
} from "@/lib/financeStats";
import { canonicalVenueCost, type VenueCostKind } from "@/lib/financeCosts";
import { groupVenues } from "@/lib/venueGroups";

export type CityCostMode = "as_billed" | "per_match";
export type CityCostScope = "realized" | "fullMonth";

// A field's cost basis is UNMAPPED (held out of net) iff its canonical kind is
// one of these — i.e. no rate, no override, no partner dashboard.
const UNMAPPED_KINDS: ReadonlySet<VenueCostKind> = new Set(["unknown", "needs_override"]);
// Share-like billing computes cost from the partner dashboard, not a per-match
// rate — so even in Per-Match mode the cost is the amount owed, never rate × n.
const SHARE_KINDS: ReadonlySet<VenueCostKind> = new Set(["profit_share", "per_match_minus_manager"]);

export type PnlField = {
  venue: string;
  mapped: boolean;
  basis: "flat" | "per_match" | "share" | "unmapped";
  dppRev: number;
  cost: number | null; // null ⟺ unmapped (never 0-for-unknown)
  net: number | null; // dppRev − cost, or null when unmapped
  matchCount: number;
  perMatchRate: number | null;
  memberSpots: number | null; // null when spot data unavailable
};

export type CityPnl = {
  city: string;
  fields: PnlField[];
  mappedDpp: number;
  fieldCost: number;
  fieldNet: number;
  untracked: number; // DPP at unmapped fields — visible, not silently dropped
  membership: number;
  overhead: { label: string; value: number }[];
  overheadTotal: number;
  net: number;
  gross: number;
  margin: number;
  citySpots: number | null;
};

function groupKind(data: FinanceData, legIds: number[], months: Q2Month[]): VenueCostKind {
  // Representative kind: prefer a mapped kind over unmapped, and share over flat,
  // scanning every (leg, month) in the period.
  let best: VenueCostKind = "unknown";
  for (const id of legIds) {
    for (const m of months) {
      const k = canonicalVenueCost(data, id, m).kind;
      if (SHARE_KINDS.has(k)) return k; // share dominates
      if (!UNMAPPED_KINDS.has(k)) best = k; // any mapped kind
    }
  }
  return best;
}

export function computeCityPnl(
  data: FinanceData,
  matchRegistrations: JoinedMatchPlayerRow[],
  city: string,
  months: Q2Month[],
  costMode: CityCostMode,
  costScope: CityCostScope,
  now: Date,
): CityPnl {
  const realized = costScope === "realized";
  const cityVenues = data.venues.filter((v) => v.city === city);
  const groups = groupVenues(cityVenues);

  const fields: PnlField[] = groups
    .map((g): PnlField => {
      const legIds = g.legs.map((l) => l.id);
      const legIdSet = new Set(legIds);
      const kind = groupKind(data, legIds, months);
      const isShare = SHARE_KINDS.has(kind);
      const mapped = !UNMAPPED_KINDS.has(kind);

      let dppRev = 0;
      let cost = 0;
      let matchCount = 0;
      let memberSpots = 0;
      for (const m of months) {
        dppRev += venuePartnerRevenueFor(data, matchRegistrations, legIdSet, m);
        // Cost: share-like always via the canonical/realized amount (the owed) —
        // never rate × n, which is the "1 × $0" bug. Plain per-match uses the
        // mode-appropriate helper; as-billed uses the canonical amount per leg.
        if (mapped) {
          if (isShare || costMode === "as_billed") {
            for (const id of legIds) {
              cost += realized ? venueRealizedCostFor(data, id, m, now) : canonicalVenueCost(data, id, m).amount;
            }
          } else {
            cost += realized ? groupPerMatchCostRealizedFor(data, g, m, now) : groupPerMatchCostFor(data, g, m);
          }
        }
        for (const id of legIds) {
          const s = venueMemberSpotsFor(data, id, m);
          memberSpots += s.member;
        }
      }

      const basis: PnlField["basis"] = !mapped ? "unmapped" : isShare ? "share" : g.legs[0].billing_type === "monthly_flat" ? "flat" : "per_match";
      return {
        venue: g.displayName,
        mapped,
        basis,
        dppRev,
        cost: mapped ? cost : null,
        net: mapped ? dppRev - cost : null,
        matchCount,
        perMatchRate: g.legs[0].per_match_rate ?? null,
        memberSpots: memberSpots > 0 ? memberSpots : null,
      };
    })
    .filter((f) => f.dppRev > 0 || (f.cost ?? 0) > 0)
    .sort((a, b) => b.dppRev - a.dppRev);

  // Aggregate under the unmapped rule.
  const mappedFields = fields.filter((f) => f.mapped);
  const unmappedFields = fields.filter((f) => !f.mapped);
  const mappedDpp = mappedFields.reduce((s, f) => s + f.dppRev, 0);
  const fieldCost = mappedFields.reduce((s, f) => s + (f.cost ?? 0), 0);
  const fieldNet = mappedDpp - fieldCost;
  const untracked = unmappedFields.reduce((s, f) => s + f.dppRev, 0);

  let membership = 0;
  const oh = { matchManagerPay: 0, cityManager: 0, marketing: 0, equipment: 0, misc: 0 };
  let citySpots = 0;
  for (const m of months) {
    membership += cityMembershipRevenueFor(data, city, m);
    const o = cityOverheadFor(data, city, m);
    oh.matchManagerPay += o.matchManagerPay;
    oh.cityManager += o.cityManager;
    oh.marketing += o.marketing;
    oh.equipment += o.equipment;
    oh.misc += o.misc;
    citySpots += cityTotalMemberSpotsFor(data, city, m);
  }
  const overhead = [
    { label: "Match Manager Pay", value: oh.matchManagerPay },
    { label: "City Manager", value: oh.cityManager },
    { label: "Marketing", value: oh.marketing },
    { label: "Equipment", value: oh.equipment },
    { label: "Misc", value: oh.misc },
  ].filter((o) => o.value !== 0);
  const overheadTotal = overhead.reduce((s, o) => s + o.value, 0);

  const net = fieldNet + membership - overheadTotal;
  const gross = mappedDpp + membership;
  const margin = gross ? net / gross : 0;

  // ASSERT the unmapped rule: no field with a null cost basis may contribute to
  // any net figure. Throw rather than render a flattering number.
  for (const f of unmappedFields) {
    if (f.cost !== null || f.net !== null) {
      throw new Error(`city-pnl: unmapped field ${city}/${f.venue} carries a cost/net (${f.cost}/${f.net})`);
    }
  }
  const recomputedNet = mappedFields.reduce((s, f) => s + (f.net ?? 0), 0) + membership - overheadTotal;
  if (Math.abs(recomputedNet - net) > 0.5) {
    throw new Error(`city-pnl: net ${net} disagrees with per-field sum ${recomputedNet} for ${city}`);
  }

  return {
    city,
    fields,
    mappedDpp,
    fieldCost,
    fieldNet,
    untracked,
    membership,
    overhead,
    overheadTotal,
    net,
    gross,
    margin,
    citySpots: citySpots > 0 ? citySpots : null,
  };
}
