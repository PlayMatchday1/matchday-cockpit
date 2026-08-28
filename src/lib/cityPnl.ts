// City P&L — one computed row per city for the ranked Finance table.
//
// THE UNMAPPED-COST RULE (the point of the exercise): a field whose cost basis
// we don't know (canonicalVenueCost kind "unknown" or "needs_override") is a
// field we cannot net, NOT a field that costs zero. Its DPP revenue is held OUT
// of DPP rev and Field net entirely and surfaced separately as `untracked`.
//
//   DPP rev    = DPP at fields whose cost basis is KNOWN, for the period
//   Member rev = collected membership revenue for the city
//   Total rev  = DPP rev + Member rev          ← the margin's denominator, now on screen
//   Field cost = venue cost at those same known-cost fields
//   Net after field cost = Total rev − Field cost
//   Overhead   = the 5 overhead categories (NO field cost — it is its own column)
//   Net P&L    = Net after field cost − Overhead
//   Margin     = Net P&L / Total rev
//
// THE ROW READS LEFT TO RIGHT AS ONE SENTENCE: what came in → what went out → what is left.
// Each step chains into the next, so any cell can be checked against its neighbours by eye.
//
// `netAfterFieldCost` REPLACED an earlier `fieldNet` that meant DPP − field cost, excluding
// membership. Both produce the same Net P&L, but the old one did not chain: Total rev − Field cost
// did not equal it, so the row could not be read across and the margin's denominator appeared
// nowhere on the page. Only this table ever consumed it.
//
// Profit-share fields (Crossbar Rowlett: per_match_minus_manager / profit_share)
// are mapped: their cost is the partner-dashboard amount owed, never "N × $0".

import type { FinanceData } from "@/lib/useFinanceData";
import type { JoinedMatchPlayerRow } from "@/lib/mdapiMatchesRead";
import {
  cityMembershipRevenuePreTaxFor,
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
  matchCount: number;
  perMatchRate: number | null;
  memberSpots: number | null; // null when spot data unavailable
  // The per-match unit the CURRENT BASIS actually charges, so the pitch's subtitle describes the
  // number in its cost cell. Per-match basis reads cost_per_match first (mirroring
  // legPerMatchUnitCost); as-billed reads per_match_rate, the invoiced figure. Without this the
  // subtitle read `per_match_rate ?? "flat billing"`, which labelled NEMP and Onion Creek — both
  // per-match venues whose unit lives in cost_per_match — as flat.
  unitCost: number | null;
  // ALLOCATED membership: city member revenue × this pitch's share of city member-spots. Computed
  // here rather than in the view so the pitch rows sum to the city row by construction — the view
  // used to do this arithmetic itself, which is how a drill-down starts disagreeing with the row
  // it opened from. null when spot data is unavailable, never 0.
  memberRev: number | null;
  totalRev: number; // dppRev + (memberRev ?? 0)
  net: number | null; // totalRev − cost, or null when unmapped
};

export type CityPnl = {
  city: string;
  fields: PnlField[];
  mappedDpp: number;
  fieldCost: number;
  // Total rev − Field cost. See the header: this chains, `fieldNet` did not.
  netAfterFieldCost: number;
  untracked: number; // DPP at unmapped fields — visible, not silently dropped
  membership: number;
  overhead: { label: string; value: number }[];
  overheadTotal: number;
  net: number;
  gross: number;
  margin: number;
  citySpots: number | null;
};

// Classify a venue group's cost basis. A field is MAPPED only when it has a real
// cost basis. The trap: autoCost returns kind "per_match" with amount 0 for a
// per-match venue whose rate is null (rate = per_match_rate ?? 0) — that is an
// UNMAPPED field wearing a mapped-looking kind, and counting its $0 is exactly
// the bug this table fixes. So a "per_match" kind only counts as mapped when the
// leg actually carries a rate (per_match_rate or cost_per_match). per_match_minus_
// manager (Crossbar) keeps its own kind and stays mapped.
function classifyGroup(
  data: FinanceData,
  legs: { id: number; per_match_rate: number | null; cost_per_match: number | null }[],
  months: Q2Month[],
): { mapped: boolean; isShare: boolean } {
  let mapped = false;
  let isShare = false;
  for (const leg of legs) {
    for (const m of months) {
      const k = canonicalVenueCost(data, leg.id, m).kind;
      if (SHARE_KINDS.has(k)) {
        isShare = true;
        mapped = true;
        continue;
      }
      if (UNMAPPED_KINDS.has(k)) continue;
      if (k === "per_match" && leg.per_match_rate == null && leg.cost_per_match == null) continue; // null-rate → unmapped
      mapped = true;
    }
  }
  return { mapped, isShare };
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
      const { mapped, isShare } = classifyGroup(data, g.legs, months);

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
      // memberRev / totalRev / net are filled in below: the allocation needs the CITY's member
      // revenue and spot total, which are not known until every field has been counted.
      return {
        venue: g.displayName,
        mapped,
        basis,
        dppRev,
        cost: mapped ? cost : null,
        matchCount,
        perMatchRate: g.legs[0].per_match_rate ?? null,
        memberSpots: memberSpots > 0 ? memberSpots : null,
        unitCost:
          !mapped || isShare || g.legs[0].billing_type === "monthly_flat"
            ? null
            : costMode === "per_match"
              ? g.legs[0].cost_per_match ?? g.legs[0].per_match_rate ?? null
              : g.legs[0].per_match_rate ?? null,
        memberRev: null,
        totalRev: dppRev,
        net: null,
      };
    })
    .filter((f) => f.dppRev > 0 || (f.cost ?? 0) > 0)
    .sort((a, b) => b.dppRev - a.dppRev);

  // Aggregate under the unmapped rule.
  const mappedFields = fields.filter((f) => f.mapped);
  const unmappedFields = fields.filter((f) => !f.mapped);
  const mappedDpp = mappedFields.reduce((s, f) => s + f.dppRev, 0);
  const fieldCost = mappedFields.reduce((s, f) => s + (f.cost ?? 0), 0);
  const untracked = unmappedFields.reduce((s, f) => s + f.dppRev, 0);

  let membership = 0;
  const oh = { matchManagerPay: 0, cityManager: 0, marketing: 0, equipment: 0, misc: 0 };
  let citySpots = 0;
  for (const m of months) {
    membership += cityMembershipRevenuePreTaxFor(data, city, m);
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

  const gross = mappedDpp + membership;
  // THE CHAIN. Total rev − Field cost = Net after field cost; − Overhead = Net P&L.
  const netAfterFieldCost = gross - fieldCost;
  const net = netAfterFieldCost - overheadTotal;
  const margin = gross ? net / gross : 0;

  // ALLOCATE membership onto the pitches, now that the city totals exist. A pitch does not sell
  // memberships — this is the city's member revenue split by that pitch's share of member-spots,
  // which is why every pitch row is marked ALLOC. A pitch with no spot data gets null, never 0.
  const spotDenom = citySpots > 0 ? citySpots : null;
  for (const f of fields) {
    f.memberRev = spotDenom != null && f.memberSpots != null ? (membership * f.memberSpots) / spotDenom : null;
    f.totalRev = f.dppRev + (f.memberRev ?? 0);
    f.net = f.cost == null ? null : f.totalRev - f.cost;
  }

  // ASSERT the unmapped rule: no field with a null cost basis may contribute to
  // any net figure. Throw rather than render a flattering number.
  for (const f of unmappedFields) {
    if (f.cost !== null || f.net !== null) {
      throw new Error(`city-pnl: unmapped field ${city}/${f.venue} carries a cost/net (${f.cost}/${f.net})`);
    }
  }
  // THE CHAIN MUST CLOSE. Each column on the row is the previous one minus the next cost, so a
  // reader can check any cell against its neighbours. If that stops being true the row is lying
  // about being a calculation, so it throws rather than renders.
  if (Math.abs(gross - (mappedDpp + membership)) > 0.5) {
    throw new Error(`city-pnl: total rev ${gross} != DPP ${mappedDpp} + member ${membership} for ${city}`);
  }
  if (Math.abs(netAfterFieldCost - (gross - fieldCost)) > 0.5 || Math.abs(net - (netAfterFieldCost - overheadTotal)) > 0.5) {
    throw new Error(`city-pnl: the chain does not close for ${city} (${gross} − ${fieldCost} − ${overheadTotal} != ${net})`);
  }
  // Per-pitch DPP and cost must sum to the city's, exactly — the drill-down is the same money
  // re-cut, not a second measurement.
  const pitchDpp = mappedFields.reduce((s, f) => s + f.dppRev, 0);
  const pitchCost = mappedFields.reduce((s, f) => s + (f.cost ?? 0), 0);
  if (Math.abs(pitchDpp - mappedDpp) > 0.5 || Math.abs(pitchCost - fieldCost) > 0.5) {
    throw new Error(`city-pnl: pitch rows do not sum to ${city} (dpp ${pitchDpp}/${mappedDpp}, cost ${pitchCost}/${fieldCost})`);
  }

  return {
    city,
    fields,
    mappedDpp,
    fieldCost,
    netAfterFieldCost,
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
