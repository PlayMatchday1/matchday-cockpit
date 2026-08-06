// The EXACT shape the public shared endpoint returns — nothing else. Built by an
// explicit field-by-field mapper (never a spread of the admin payload), so a new
// field added to ManagerPayWeekPayload does NOT silently publish to the shared
// link. Deliberately omits: all emails, adjustment reasons + timestamps, isAdmin,
// computedAt, the needs-a-look/attention block, and registrationPrice.

import type { ManagerPayWeekPayload } from "./managerPayCompute";
import type { ArrivalInfo } from "./managerPayArrival";

export type SharedManagerMatch = {
  matchId: number;
  fieldTitle: string | null;
  centralDate: string;
  centralWeekday: string;
  centralTime: string;
  maxPlayerCount: number | null;
  payAmount: number;
  role: "primary" | "secondary";
  coManaged: boolean;
};
export type SharedManager = {
  managerName: string;
  cityIdentifier: string | null;
  matchCount: number;
  baseTotal: number;
  adjustment: number;
  total: number;
  matches: SharedManagerMatch[];
};
export type SharedMatch = {
  matchId: number;
  fieldTitle: string | null;
  centralDate: string;
  centralWeekday: string;
  centralTime: string;
  name: string | null;
  maxPlayerCount: number | null;
  playerCount: number | null;
  isCancelled: boolean;
  primaryManagerName: string | null;
  secondManagerName: string | null;
  payPerManager: number;
};
export type SharedCity = {
  cityIdentifier: string;
  matchCount: number;
  baseTotal: number;
  adjustment: number;
  total: number;
  managers: SharedManager[];
  matches: SharedMatch[];
};
export type SharedArrivalOverride = { date: string; reason: string; by: string | null; at: string };
export type SharedManagerPayPayload = {
  weekStart: string;
  weekEnd: string;
  payRun: string | null; // pay-run Tuesday (banking-day adjusted) — "when I submit"
  payDate: string; // accounting Tuesday (weekStart+8), for the "pays" label
  estimatedArrival: string | null; // computed arrival
  effectiveArrival: string | null; // override.date ?? estimatedArrival
  arrivalOverride: SharedArrivalOverride | null;
  cities: SharedCity[];
  network: { matchCount: number; managerCount: number; baseTotal: number; adjustment: number; total: number };
};

export function toSharedPayload(full: ManagerPayWeekPayload, arrival: ArrivalInfo): SharedManagerPayPayload {
  return {
    weekStart: full.weekStart,
    weekEnd: full.weekEnd,
    payRun: arrival.payRun,
    payDate: full.payDate,
    estimatedArrival: arrival.estimatedArrival,
    effectiveArrival: arrival.effectiveArrival,
    arrivalOverride: arrival.override
      ? { date: arrival.override.date, reason: arrival.override.reason, by: arrival.override.by, at: arrival.override.at }
      : null,
    cities: full.cities.map((c) => ({
      cityIdentifier: c.cityIdentifier,
      matchCount: c.matchCount,
      baseTotal: c.baseTotal,
      adjustment: c.adjustment,
      total: c.total,
      managers: c.managers.map((m) => ({
        managerName: m.managerName,
        cityIdentifier: m.cityIdentifier,
        matchCount: m.matchCount,
        baseTotal: m.baseTotal,
        adjustment: m.adjustment,
        total: m.total,
        matches: m.matches.map((mm) => ({
          matchId: mm.matchId,
          fieldTitle: mm.fieldTitle,
          centralDate: mm.centralDate,
          centralWeekday: mm.centralWeekday,
          centralTime: mm.centralTime,
          maxPlayerCount: mm.maxPlayerCount,
          payAmount: mm.payAmount,
          role: mm.role,
          coManaged: mm.coManaged,
        })),
      })),
      matches: c.matches.map((mm) => ({
        matchId: mm.matchId,
        fieldTitle: mm.fieldTitle,
        centralDate: mm.centralDate,
        centralWeekday: mm.centralWeekday,
        centralTime: mm.centralTime,
        name: mm.name,
        maxPlayerCount: mm.maxPlayerCount,
        playerCount: mm.playerCount,
        isCancelled: mm.isCancelled,
        primaryManagerName: mm.primaryManagerName,
        secondManagerName: mm.secondManagerName,
        payPerManager: mm.payPerManager,
      })),
    })),
    network: {
      matchCount: full.network.matchCount,
      managerCount: full.network.managerCount,
      baseTotal: full.network.baseTotal,
      adjustment: full.network.adjustment,
      total: full.network.total,
    },
  };
}
