// The partner-facing dashboard — ONE rendering, two callers: the public
// tokenised route (/partners/<slug>, server-rendered) and the Match Ops admin
// index (below its seam). No "use client", no hooks, no fetching — it takes the
// already-computed stats + payment and renders. Every figure is derived; nothing
// is typed in. All period math comes from src/lib/partnerDashboardView.ts so the
// admin switcher's owed total and this table can never disagree.
//
// This page goes to an outside party. It may not assert anyone was present —
// MatchDay records no check-in — so every player count says "spots filled"/"held"
// and the page states outright it is not attendance. One money format throughout
// (money()), with the negative branch inside the formatter.

import type { PartnerStats, PartnerPaymentInfo, PartnerRevenueModel } from "@/lib/partnerStats";
import {
  money, plural, dfull, dshort, todayYmd, unitFor,
  derivePeriodRows, deriveOwed, closedPaymentTotal, type PeriodRow,
} from "@/lib/partnerDashboardView";

const C = {
  forestDeep: "#072a20", forest: "#0d3b2e", accent: "#35c77f", logo: "#2cdb87", mint: "#e0f2e7",
  amount: "#e2502b", ink: "#12241d", muted: "#6d7b74",
  warnBg: "#fdf1d0", warnInk: "#8a6300", warnLine: "#e3c369",
  critBg: "#fdeae4", critInk: "#a8391a", critLine: "#f0bda9", ok: "#12704a",
  railA: "#fafbfa", railB: "#f6f9f7", chipBg: "#eef3f0", chipLine: "#e2eae5",
  line: "#e6ebe8", hair: "#eff3f1", surface: "#ffffff", canvas: "#f4efe4",
};

export type PartnerDashboardViewProps = {
  partnerName: string;
  venue: string;
  city: string | null;
  launchDate: string | null; // YYYY-MM-DD; falls back to earliest match
  stats: PartnerStats;
  payment: PartnerPaymentInfo;
  isPublic: boolean; // true → self-standing (wordmark, canvas bg); false → inside admin chrome
};

const em = "—";
const numCell = (n: number | null) => (n == null ? em : n.toLocaleString("en-US"));

export default function PartnerDashboardView({ partnerName, venue, city, launchDate, stats, payment, isPublic }: PartnerDashboardViewProps) {
  const today = todayYmd();
  const cadence = payment.cadence;
  const unit = unitFor(cadence);
  const rows: PeriodRow[] = derivePeriodRows(payment, today);
  const owed = deriveOwed(rows);
  const totalMatches = stats.weeks.reduce((s, w) => s + (w.voided ? 0 : w.matches), 0);
  const launch = launchDate ?? stats.earliestMatchDate;
  const perMatch = payment.revenueModel === "per_match_minus_manager";

  return (
    <div style={{ background: isPublic ? C.canvas : C.surface, color: C.ink, padding: isPublic ? "26px 4px 20px" : "22px 24px 20px", borderRadius: 13, border: isPublic ? "1px solid transparent" : `1px solid ${C.line}` }}>
      {/* A bookmarked link opens with no Clubhouse chrome, so it must say who
          sent it. Inside admin chrome (isPublic=false) the wordmark is redundant. */}
      {isPublic && <div style={{ fontSize: 10.5, letterSpacing: "2.2px", fontWeight: 900, color: C.forestDeep, marginBottom: 10 }}>MATCHDAY</div>}

      <h1 style={{ fontSize: 26, fontWeight: 900, letterSpacing: "-0.3px", color: C.forestDeep, margin: 0 }}>
        {partnerName.toUpperCase()} <span style={{ color: "#9aa8a1", fontWeight: 900 }}>— PARTNER DASHBOARD</span>
      </h1>
      <p style={{ color: C.muted, fontSize: 12.5, fontWeight: 600, margin: "6px 0 0" }}>
        {venue}{city ? ` · ${city}` : ""}{launch ? ` · ${dfull(launch)} through ${dfull(today)}` : ""} · MatchDay staff spots excluded · revenue is the match price players actually paid
      </p>

      {/* ── SINCE LAUNCH tiles ── */}
      <section style={{ marginTop: 22 }} data-testid="tiles">
        <div style={slab}>SINCE LAUNCH</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }} className="pd-tiles">
          <Tile n={stats.totals.spots} lab="SPOTS FILLED" note="Spots paid for and held. MatchDay does not record check-in, so this is not attendance." />
          <Tile n={stats.totals.md} lab="BOOKED BY REGISTERED PLAYERS" note="Held by someone with a MatchDay account." />
          <Tile n={stats.totals.guests} lab="GUEST SPOTS" note="Bought by a registered player for someone without an account." />
          <Tile n={stats.totals.cancels} lab="CANCELLED INSIDE 24 HOURS" note="Non-refundable, so the revenue below still counts them." />
          <Tile n={stats.totals.uniquePlayers} lab="DISTINCT PEOPLE" note={`Held at least one spot. Averages ${stats.totals.uniquePlayers ? (stats.totals.spots / stats.totals.uniquePlayers).toFixed(1) : "0"} spots each over ${plural(totalMatches, "match", "matches")}.`} />
        </div>
      </section>

      {/* ── ONE table, one row per period ── */}
      {payment.enabled ? (
        <section style={{ marginTop: 22 }}>
          <div style={slab}>EVERY {unit.toUpperCase()}</div>
          <div style={{ overflowX: "auto" }}>
            <PeriodTable rows={rows} perMatch={perMatch} sharePct={payment.revenueSharePct} unit={unit} cadence={cadence} />
          </div>
          {/* ONE control for the whole table, outside it. */}
          <div style={{ marginTop: 9 }}>
            <a href="mailto:ryan@playmatchday.com?subject=Partner%20payment%20question" data-testid="fix-control" style={{ fontSize: 11.5, fontWeight: 700, color: C.forest, textDecoration: "underline", textUnderlineOffset: 2, display: "inline-block", padding: "6px 8px", margin: "-6px -8px", minHeight: 28 }}>
              A payment here is missing or wrong →
            </a>
          </div>
        </section>
      ) : (
        <section style={{ marginTop: 22 }}>
          <div style={slab}>EVERY {unit.toUpperCase()}</div>
          <div style={{ ...card, padding: "18px 16px", color: C.muted, fontSize: 13 }}>Payment tracking isn&rsquo;t enabled for this partner yet.</div>
        </section>
      )}

      {/* ── recent weeks (monthly partners only; the weekly table above already is the week view) ── */}
      {cadence === "monthly" && <RecentWeeks stats={stats} />}

      <Footer rows={rows} stats={stats} totalMatches={totalMatches} owed={owed.owed} venue={venue} launch={launch} today={today} cadence={cadence} perMatch={perMatch} sharePct={payment.revenueSharePct} />
    </div>
  );
}

const slab: React.CSSProperties = { fontSize: 9.5, letterSpacing: "1.3px", fontWeight: 800, color: C.muted, marginBottom: 9 };
const card: React.CSSProperties = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 11 };

function Tile({ n, lab, note }: { n: number; lab: string; note: string }) {
  return (
    <div style={{ ...card, padding: "12px 13px 11px" }} data-testid="tile">
      <u style={{ display: "block", textDecoration: "none", fontSize: 10, letterSpacing: "0.8px", fontWeight: 800, color: C.muted, marginBottom: 6 }}>{lab}</u>
      <b style={{ display: "block", fontSize: 26, fontWeight: 900, letterSpacing: "-0.5px", lineHeight: 1.1, color: C.forestDeep }}>{n.toLocaleString("en-US")}</b>
      <i style={{ display: "block", fontStyle: "normal", fontSize: 11, color: C.muted, fontWeight: 600, marginTop: 5, lineHeight: 1.4 }}>{note}</i>
    </div>
  );
}

// ── the table ────────────────────────────────────────────────────────────────
const th: React.CSSProperties = { fontSize: 9.5, letterSpacing: "1.1px", fontWeight: 800, color: C.muted, textAlign: "left", padding: "9px 13px", background: C.railA, borderBottom: `1px solid ${C.line}` };
const thN: React.CSSProperties = { ...th, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const td: React.CSSProperties = { padding: "11px 13px", borderBottom: `1px solid ${C.hair}`, fontSize: 13, fontWeight: 600 };
const tdN: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const gl = `1px solid ${C.line}`; // the vertical rule between the two groups (full height)
const sub: React.CSSProperties = { display: "block", fontSize: 11, color: C.muted, fontWeight: 600, marginTop: 3 };

function PeriodTable({ rows, perMatch, sharePct, unit, cadence }: { rows: PeriodRow[]; perMatch: boolean; sharePct: number; unit: string; cadence: "weekly" | "monthly" }) {
  const midHeader = perMatch ? "MATCH MANAGER PAY" : `YOUR SHARE (${sharePct}%)`;
  const sum = (f: (r: PeriodRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", background: C.surface, border: `1px solid ${C.line}`, borderRadius: 11, overflow: "hidden" }} data-testid="period-table">
      <thead>
        <tr>
          <th rowSpan={2} style={th}>PERIOD</th>
          <th colSpan={4} style={{ ...th, textAlign: "center", fontSize: 9, letterSpacing: "1.4px", color: C.forestDeep, background: C.railB, paddingBottom: 7 }}>WHAT PLAYERS PAID</th>
          <th colSpan={4} style={{ ...th, textAlign: "center", fontSize: 9, letterSpacing: "1.4px", color: C.forestDeep, background: C.railB, paddingBottom: 7, borderLeft: gl }}>WHAT THAT MEANS FOR YOU</th>
        </tr>
        <tr>
          <th style={thN}>MATCHES</th><th style={thN}>CHARGED</th><th style={thN}>REFUNDED</th><th style={thN}>QUALIFYING REVENUE</th>
          <th style={{ ...thN, borderLeft: gl }}>{midHeader}</th><th style={thN}>PAYMENT</th><th style={th}>STATUS</th><th style={th}>WHEN</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => <PeriodRowTr key={r.pw.weekStartDate} r={r} perMatch={perMatch} sharePct={sharePct} unit={unit} cadence={cadence} />)}
        <tr>
          <td style={{ ...td, background: C.railA, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>All {plural(rows.length, unit)}</td>
          <td style={{ ...tdN, background: C.railA, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>{sum((r) => r.matches ?? 0)}</td>
          <td style={{ ...tdN, background: C.railA, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>{money(sum((r) => r.charged ?? 0))}</td>
          <td style={{ ...tdN, background: C.railA, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>{sum((r) => r.refunded ?? 0) ? money(sum((r) => r.refunded ?? 0)) : em}</td>
          <td style={{ ...tdN, background: C.railA, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>{money(sum((r) => r.qualifying ?? 0))}</td>
          <td style={{ ...tdN, background: C.railA, fontWeight: 800, borderTop: `1px solid ${C.line}`, borderLeft: gl }}>{perMatch ? "−" + money(sum((r) => r.managerPay)) : `${sharePct}%`}</td>
          <td style={{ ...tdN, background: C.railA, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>{money(closedPaymentTotal(rows))}<span style={sub}>closed {unit}s only</span></td>
          <td colSpan={2} style={{ ...td, background: C.railA, borderTop: `1px solid ${C.line}` }} />
        </tr>
      </tbody>
    </table>
  );
}

function PeriodRowTr({ r, perMatch, sharePct, unit, cadence }: { r: PeriodRow; perMatch: boolean; sharePct: number; unit: string; cadence: "weekly" | "monthly" }) {
  const today = todayYmd();
  const statusPill = (() => {
    switch (r.state) {
      case "open": return <Pill bg="#eaf1fb" fg="#2a4f86" line="#c6d8ef">In progress</Pill>;
      case "paid": case "presystem": return <Pill bg="#e7f6ee" fg={C.ok} line="#bfe0cd">Paid</Pill>;
      case "past_due": return <Pill bg={C.critBg} fg={C.critInk} line={C.critLine}>Past due</Pill>;
      case "scheduled": return <Pill bg={C.warnBg} fg={C.warnInk} line={C.warnLine}>Scheduled</Pill>;
      case "disputed": return <Pill bg={C.critBg} fg={C.critInk} line={C.critLine}>Disputed</Pill>;
      default: return <Pill bg={C.chipBg} fg={C.muted} line={C.chipLine}>Nothing owed</Pill>;
    }
  })();
  const when = (() => {
    if (r.isOpen) return <span style={{ color: C.muted }}>Closes {dfull(r.pw.weekEndDate)}</span>;
    switch (r.state) {
      // a $0 period stated as a positive shortfall — "is −$58" reads like a debt
      case "nothing": return <span style={{ color: C.muted }}>{r.shortfall > 0 ? `Fell ${money(r.shortfall)} short of match manager pay — not carried forward` : "Nothing was owed this " + unit}</span>;
      case "paid": case "presystem": return r.paidOn ? dfull(r.paidOn) : em;
      case "past_due": return <span style={{ color: C.critInk }}>Was due {dfull(r.dueDate)}</span>;
      case "scheduled": return `Due ${dfull(r.dueDate)}`;
      case "disputed": return r.pw.disputeNote ? r.pw.disputeNote : "Under review";
      default: return em;
    }
  })();
  return (
    <tr>
      <td style={td}>{r.label}{r.isOpen && <span style={sub}>Partial — through {dfull(today)}, not a full {unit}</span>}</td>
      <td style={tdN}>{numCell(r.matches)}</td>
      <td style={tdN}>{r.charged == null ? em : money(r.charged)}</td>
      <td style={tdN}>{r.refunded ? money(r.refunded) : em}</td>
      <td style={tdN}>{r.qualifying == null ? em : money(r.qualifying)}</td>
      <td style={{ ...tdN, borderLeft: gl }}>{perMatch ? (r.pw.isPreSystem ? em : "−" + money(r.managerPay)) : `${sharePct}%`}</td>
      <td style={tdN}>{r.payment == null ? <span style={{ color: C.muted }}>{em}<span style={sub}>Not yet calculated</span></span> : <b>{money(r.payment)}</b>}</td>
      <td style={td}>{statusPill}</td>
      <td style={{ ...td, fontSize: 12, color: C.ink }}>{when}</td>
    </tr>
  );
}

function Pill({ bg, fg, line, children }: { bg: string; fg: string; line: string; children: React.ReactNode }) {
  return <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 800, padding: "2px 8px", borderRadius: 999, border: `1px solid ${line}`, background: bg, color: fg, whiteSpace: "nowrap" }}>{children}</span>;
}

function RecentWeeks({ stats }: { stats: PartnerStats }) {
  const active = stats.weeks.filter((w) => !w.voided && w.matches > 0).slice(-8);
  if (active.length === 0) return null;
  return (
    <section style={{ marginTop: 22 }}>
      <div style={slab}>THE LAST {active.length} WEEKS WITH A MATCH</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(124px, 1fr))", gap: 9, paddingBottom: 5 }}>
        {active.map((w) => {
          if (w.voided) return null;
          const mon = w.wkMonday;
          const sun = new Date(`${mon}T00:00:00Z`); sun.setUTCDate(sun.getUTCDate() + 6);
          return (
            <div key={w.wkMonday} style={{ ...card, padding: "11px 12px" }} data-testid="week-card">
              <div style={{ fontSize: 10, letterSpacing: "0.7px", fontWeight: 800, color: C.muted }}>WEEK OF</div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginTop: 1 }}>{dshort(mon)} – {dshort(sun.toISOString().slice(0, 10))}</div>
              <div style={{ fontSize: 23, fontWeight: 900, color: C.forestDeep, marginTop: 7, letterSpacing: "-0.4px" }}>{w.totalPlayers}</div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginTop: 2 }}>spots held</div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginTop: 2 }}>{plural(w.matches, "match", "matches")} · {money(w.totalRev)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Footer({ rows, stats, totalMatches, owed, venue, launch, today, cadence, perMatch, sharePct }: {
  rows: PeriodRow[]; stats: PartnerStats; totalMatches: number; owed: number; venue: string; launch: string | null; today: string; cadence: "weekly" | "monthly"; perMatch: boolean; sharePct: number;
}) {
  const t = stats.totals;
  const none = rows.filter((r) => r.state === "nothing" && r.shortfall > 0);
  const shortfall = none.reduce((s, r) => s + r.shortfall, 0);
  const open = rows.find((r) => r.isOpen);
  const dueCopy = cadence === "weekly" ? "on the Friday after each week closes" : "on the 5th of the following month";
  const paymentRule = perMatch
    ? "Your payment is qualifying revenue less what MatchDay paid the match managers who ran those matches. When that subtraction is negative the payment is $0 and the shortfall is NOT carried into the next period"
    : `Your payment is ${sharePct}% of qualifying revenue`;
  const floorSentence = perMatch
    ? ` — ${none.length ? `that has happened in ${plural(none.length, "period")} so far, for a combined ${money(shortfall)} MatchDay absorbed` : "that has not happened in any period so far"}`
    : "";
  const text =
    `Everything here covers ${venue} only${launch ? `, from ${dfull(launch)} — the first match MatchDay ran at this venue —` : ""} through ${dfull(today)}, and counts ${plural(totalMatches, "match", "matches")}. ` +
    `Spots filled means a spot was paid for and held; MatchDay does not record who physically arrived, so no number on this page is attendance, including the ${t.uniquePlayers} distinct people. ` +
    `${t.cancels} spots were cancelled inside 24 hours: those are non-refundable, so they are still counted as charged. ` +
    `Qualifying revenue is what players were charged, less any refunds. ${paymentRule}${floorSentence}. ` +
    `Payments run ${cadence}, ${dueCopy}; ${owed > 0 ? `${money(owed)} is currently scheduled or outstanding` : "nothing is currently outstanding"}. ` +
    `${open ? `${open.label} is still open — it closes ${dfull(open.pw.weekEndDate)}, so its figures are partial and no payment is calculated for it yet. ` : ""}` +
    `Figures update when the match data syncs, roughly hourly. If a number here does not match your own records, use the link directly under the table above and MatchDay will reconcile it.`;
  return <div data-testid="footer" style={{ marginTop: 20, fontSize: 11.5, lineHeight: 1.65, color: C.muted, fontWeight: 600, borderTop: `1px solid ${C.line}`, paddingTop: 13, maxWidth: 1180 }}>{text}</div>;
}
