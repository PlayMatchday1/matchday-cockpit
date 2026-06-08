"use client";

// Shared rendering primitives for Match P&L views.
//
// Extracted from MatchPnL.tsx so the Slate Review tab can render the
// same per-match table, scoped to one city for the last completed
// week. Keep visual changes here so both surfaces stay in sync.

import type { MatchPnLRow, MatchPnLStatus } from "@/lib/matchPnL";

export type SortKey =
  | "match"
  | "city"
  | "spotsSold" // labeled "Spots Booked"
  | "paidSpots"
  | "memberSpots"
  | "grossRevenue" // labeled "DPP Rev"; field name kept stable
  | "memberRev" // labeled "Member Rev"
  | "credit"
  | "total" // DPP + Member
  | "fieldCost"
  | "net"
  | "status";
export type SortDir = "asc" | "desc";

export const STATUS_PILL: Record<MatchPnLStatus, string> = {
  loss: "bg-coral-soft text-coral",
  breakeven: "bg-[rgba(245,158,11,0.15)] text-[#92400E]",
  profit: "bg-mint-soft text-deep-green",
  "missing-cost": "bg-cream-soft text-deep-green/55",
  // Distinct gray pill so canceled matches don't visually compete
  // with active losses — the operator's eye should land on Loss
  // rows first, then scan canceled separately.
  canceled: "bg-deep-green/10 text-deep-green/55",
};

export const STATUS_LABEL: Record<MatchPnLStatus, string> = {
  loss: "Loss",
  breakeven: "Breakeven",
  profit: "Profit",
  "missing-cost": "No cost set",
  canceled: "Canceled",
};

export function fmtUsd(n: number): string {
  const r = Math.round(n);
  const sign = r < 0 ? "-" : "";
  return `${sign}$${Math.abs(r).toLocaleString("en-US")}`;
}

export function fmtSig(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "$0";
  return r > 0 ? `+$${r.toLocaleString("en-US")}` : `-$${Math.abs(r).toLocaleString("en-US")}`;
}

export function fmtMonthDay(d: Date): string {
  return `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()}`;
}

export type CitySubtotal = {
  matches: number;
  gross: number;
  memberRev: number;
  memberSpots: number;
  paidSpots: number;
  credit: number;
  freeNonMemberSpots: number;
  cost: number;
  net: number;
  losses: number;
};

export function citySubtotal(rows: MatchPnLRow[]): CitySubtotal {
  let gross = 0;
  let memberRev = 0;
  let memberSpots = 0;
  let paidSpots = 0;
  let credit = 0;
  let freeNonMemberSpots = 0;
  let cost = 0;
  let losses = 0;
  for (const r of rows) {
    gross += r.grossRevenue;
    memberRev += r.allocatedMemberRev;
    memberSpots += r.memberSpots;
    paidSpots += r.paidSpots;
    credit += r.credit;
    freeNonMemberSpots += r.freeNonMemberSpots;
    if (r.fieldCost !== null) cost += r.fieldCost;
    if (r.status === "loss") losses++;
  }
  return {
    matches: rows.length,
    gross,
    memberRev,
    memberSpots,
    paidSpots,
    credit,
    freeNonMemberSpots,
    cost,
    net: gross + memberRev - cost,
    losses,
  };
}

// Sortable column headers rendered as a <tr>. Lives inside each
// city's <tbody> rather than a single top-of-table <thead> so the
// labels stay visible while scrolling past long city sections.
// Sort state + handler are threaded in so each repeated row still
// drives the same global sort.
export function ColumnHeadersRow({
  sortKey,
  sortDir,
  onClick,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  return (
    <tr className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
      <SortHeader k="match" label="Match" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="left" />
      <SortHeader k="city" label="City" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="left" />
      <SortHeader k="spotsSold" label="Spots Booked" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader
        k="paidSpots"
        label="Paid Spots"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Count of DAILY PAID fills at this match. Excludes MEMBER, FREE_NON_MEMBER, and PROMOCODE."
      />
      <SortHeader k="grossRevenue" label="DPP Rev" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader
        k="memberSpots"
        label="Member Spots"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Count of MEMBER fills at this match (subscription-joined). Pairs with Member Rev valued at the latest completed month's benchmark rate."
      />
      <SortHeader
        k="memberRev"
        label="Member Rev"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Member play valued at the city's benchmark rate (memberSpots × the latest completed month's $/spot). Not collected membership revenue; that lives on /finance Cities."
      />
      <SortHeader
        k="credit"
        label="Credit"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Portion of DPP Rev paid via account credit (already included in DPP Rev, not additive)."
      />
      <SortHeader
        k="total"
        label="Total"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="DPP + Member. The actual gross revenue for the match (cash spots + allocated membership share)."
      />
      <SortHeader k="fieldCost" label="Field Cost" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader k="net" label="Net" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader k="status" label="Status" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="left" />
    </tr>
  );
}

function SortHeader({
  k,
  label,
  sortKey,
  sortDir,
  onClick,
  align,
  tooltip,
}: {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align: "left" | "right";
  tooltip?: string;
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onClick(k)}
        title={tooltip}
        className={`inline-flex items-center gap-1 transition hover:text-deep-green ${active ? "text-deep-green" : ""}`}
      >
        {label}
        <span className="text-[9px]">{arrow}</span>
      </button>
    </th>
  );
}

export function Row({
  row,
  onJumpToConfig,
}: {
  row: MatchPnLRow;
  onJumpToConfig?: (venueId: number) => void;
}) {
  return (
    <tr className="border-t border-cream-line/60">
      <td className="px-3 py-2 align-top">
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-deep-green">{row.venueDisplayName}</span>
          {row.isTournament && <TournamentBadge />}
        </div>
        <div className="text-[11px] text-deep-green/55">
          {row.dayLabel}, {fmtMonthDay(row.matchStart)} · {row.timeLabel}
        </div>
      </td>
      <td className="px-3 py-2 align-top text-deep-green/75">{row.city}</td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.status === "canceled" ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          row.spotsSold
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.status === "canceled" ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          row.paidSpots
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {fmtUsd(row.grossRevenue)}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.status === "canceled" ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          row.memberSpots
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {fmtUsd(row.allocatedMemberRev)}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.credit > 0 ? fmtUsd(row.credit) : (
          <span className="text-deep-green/35">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums font-bold text-deep-green">
        {fmtUsd(row.grossRevenue + row.allocatedMemberRev)}
      </td>
      <td className="px-3 py-2 text-right align-top">
        {row.fieldCost === null ? (
          row.venueId !== null && onJumpToConfig ? (
            <button
              type="button"
              onClick={() => onJumpToConfig(row.venueId as number)}
              className="font-mono text-[11px] italic text-coral underline-offset-2 hover:underline"
              title="Jump to Field Costs config to set this venue's cost/match"
            >
              $? — set in Field Costs
            </button>
          ) : (
            <span className="font-mono text-[11px] italic text-deep-green/45">
              $? — set in Field Costs
            </span>
          )
        ) : (
          <span className="font-mono tabular-nums text-deep-green">
            {fmtUsd(row.fieldCost)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top">
        {row.net === null ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          <span
            className={`font-mono font-bold tabular-nums ${
              row.net > 10
                ? "text-mint-hover"
                : row.net < -10
                  ? "text-coral"
                  : "text-deep-green/75"
            }`}
          >
            {fmtSig(row.net)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_PILL[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </td>
    </tr>
  );
}

// Mobile-only city header. Compact subtitle wraps across multiple
// lines rather than running off the right edge of the screen.
export function MobileCityHeader({
  city,
  sub,
  benchmarkLabel,
}: {
  city: string;
  sub: {
    matches: number;
    gross: number;
    memberRev: number;
    memberSpots: number;
    paidSpots: number;
    credit: number;
    cost: number;
    net: number;
    losses: number;
  };
  benchmarkLabel: string;
}) {
  const netClass =
    sub.net > 10
      ? "text-mint-hover"
      : sub.net < -10
        ? "text-coral"
        : "text-deep-green/55";
  return (
    <div className="border-b border-cream-line/60 pb-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-deep-green">
          {city}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
          {sub.matches} {sub.matches === 1 ? "match" : "matches"}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-deep-green/65">
        <span>
          Total{" "}
          <span className="font-mono font-bold tabular-nums text-deep-green">
            {fmtUsd(sub.gross + sub.memberRev)}
          </span>
        </span>
        <span>
          Cost{" "}
          <span className="font-mono tabular-nums text-deep-green">
            {fmtUsd(sub.cost)}
          </span>
        </span>
        <span>
          Net{" "}
          <span className={`font-mono font-bold tabular-nums ${netClass}`}>
            {fmtSig(sub.net)}
          </span>
        </span>
        {sub.losses > 0 && (
          <span>
            <span className="font-bold tabular-nums text-coral">
              {sub.losses}
            </span>{" "}
            loss{sub.losses === 1 ? "" : "es"}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] italic text-deep-green/45">
        {benchmarkLabel}
      </div>
    </div>
  );
}

// Mobile-only match card. Used in all three sections (active by city,
// no-cost, canceled). Adapts to each status:
//   active           → spots populated, net colored
//   canceled         → spots show "—" (match never ran)
//   missing-cost     → cost cell renders the "$? — set in Field Costs"
//                      affordance, net shows "—"
export function MobileMatchCard({
  row,
  expanded,
  onToggle,
  onJumpToConfig,
}: {
  row: MatchPnLRow;
  expanded: boolean;
  onToggle: () => void;
  onJumpToConfig?: (venueId: number) => void;
}) {
  const isCanceled = row.status === "canceled";
  const totalRev = row.grossRevenue + row.allocatedMemberRev;
  const netClass =
    row.net === null
      ? ""
      : row.net > 10
        ? "text-mint-hover"
        : row.net < -10
          ? "text-coral"
          : "text-deep-green/75";
  return (
    <div className="rounded-xl border border-cream-line bg-white p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-deep-green">
              {row.venueDisplayName}
            </span>
            {row.isTournament && <TournamentBadge />}
          </div>
          <div className="mt-0.5 text-[11px] text-deep-green/55">
            {row.dayLabel}, {fmtMonthDay(row.matchStart)} · {row.timeLabel}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_PILL[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div className="flex flex-col rounded-md bg-cream-soft/50 px-2 py-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            Total
          </span>
          <span className="font-mono font-bold tabular-nums text-deep-green">
            {fmtUsd(totalRev)}
          </span>
        </div>
        <div className="flex flex-col rounded-md bg-cream-soft/50 px-2 py-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            Cost
          </span>
          {row.fieldCost === null ? (
            row.venueId !== null && onJumpToConfig ? (
              <button
                type="button"
                onClick={() => onJumpToConfig(row.venueId as number)}
                className="text-left font-mono italic text-coral underline-offset-2 hover:underline"
              >
                $?
              </button>
            ) : (
              <span className="font-mono italic text-deep-green/45">$?</span>
            )
          ) : (
            <span className="font-mono tabular-nums text-deep-green">
              {fmtUsd(row.fieldCost)}
            </span>
          )}
        </div>
        <div className="flex flex-col rounded-md bg-cream-soft/50 px-2 py-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            Net
          </span>
          {row.net === null ? (
            <span className="font-mono text-deep-green/35">—</span>
          ) : (
            <span className={`font-mono font-bold tabular-nums ${netClass}`}>
              {fmtSig(row.net)}
            </span>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/55 transition hover:bg-cream-soft hover:text-deep-green"
      >
        <span aria-hidden>{expanded ? "▴" : "▾"}</span>
        {expanded ? "Less" : "More"}
      </button>

      {expanded && (
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-cream-line/60 pt-2 text-[11px]">
          <InlineMetric
            label="Spots Booked"
            value={isCanceled ? "—" : String(row.spotsSold)}
          />
          <InlineMetric
            label="Paid Spots"
            value={isCanceled ? "—" : String(row.paidSpots)}
          />
          <InlineMetric
            label="Member Spots"
            value={isCanceled ? "—" : String(row.memberSpots)}
          />
          <InlineMetric label="DPP Rev" value={fmtUsd(row.grossRevenue)} />
          <InlineMetric
            label="Member Rev"
            value={fmtUsd(row.allocatedMemberRev)}
          />
          <InlineMetric
            label="Credit"
            value={row.credit > 0 ? fmtUsd(row.credit) : "—"}
          />
        </div>
      )}
    </div>
  );
}

function InlineMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-deep-green/55">{label}</span>
      <span className="font-mono tabular-nums text-deep-green/85">{value}</span>
    </div>
  );
}

// Small chip next to a Soccer Central match's venue name when the
// row is on the Tournament leg ($120, two side-by-side 9v9 fields).
// Same pattern as the existing status pills — mint pill so it reads
// as informational rather than alarming.
function TournamentBadge() {
  return (
    <span
      title="Soccer Central tournament — two fields, $120"
      className="shrink-0 rounded-full bg-mint-soft px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-deep-green ring-1 ring-mint/40"
    >
      Tournament
    </span>
  );
}

// Default sort direction for a given column. Most metric columns sort
// descending (largest first); net + identifiers ascending (worst /
// alpha first). Used by toggleSort handlers when switching keys so
// both surfaces feel the same.
export function defaultSortDirFor(k: SortKey): SortDir {
  return k === "spotsSold" ||
    k === "paidSpots" ||
    k === "memberSpots" ||
    k === "grossRevenue" ||
    k === "memberRev" ||
    k === "credit" ||
    k === "total" ||
    k === "fieldCost"
    ? "desc"
    : "asc";
}

// Shared row comparator. Pulled out so MatchPnL and the Slate Review
// section sort identically — keep the column order changes in lockstep
// with ColumnHeadersRow above.
export function compareRows(
  a: MatchPnLRow,
  b: MatchPnLRow,
  sortKey: SortKey,
  sortDir: SortDir,
): number {
  const dir = sortDir === "asc" ? 1 : -1;
  switch (sortKey) {
    case "match":
      return (
        (a.venueDisplayName.localeCompare(b.venueDisplayName) ||
          a.matchStart.getTime() - b.matchStart.getTime()) * dir
      );
    case "city":
      return a.city.localeCompare(b.city) * dir;
    case "spotsSold":
      return (a.spotsSold - b.spotsSold) * dir;
    case "paidSpots":
      return (a.paidSpots - b.paidSpots) * dir;
    case "memberSpots":
      return (a.memberSpots - b.memberSpots) * dir;
    case "grossRevenue":
      return (a.grossRevenue - b.grossRevenue) * dir;
    case "memberRev":
      return (a.allocatedMemberRev - b.allocatedMemberRev) * dir;
    case "credit":
      return (a.credit - b.credit) * dir;
    case "total":
      return (
        (a.grossRevenue + a.allocatedMemberRev -
          (b.grossRevenue + b.allocatedMemberRev)) *
        dir
      );
    case "fieldCost":
      return ((a.fieldCost ?? 0) - (b.fieldCost ?? 0)) * dir;
    case "net":
      return ((a.net ?? 0) - (b.net ?? 0)) * dir;
    case "status": {
      const order: Record<MatchPnLStatus, number> = {
        loss: 0,
        breakeven: 1,
        profit: 2,
        "missing-cost": 3,
        canceled: 4,
      };
      return (order[a.status] - order[b.status]) * dir;
    }
  }
}
