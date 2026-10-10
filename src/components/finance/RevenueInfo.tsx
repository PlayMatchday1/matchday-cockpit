"use client";

/* THE REVENUE PAGE'S INFO POPOVERS — the copy is below (POP); the behaviour is the mock's
 * (scripts/mocks/finance-revenue-v2.html): click opens, a second click on the same
 * i closes, a click anywhere else or Esc closes, and only one is ever open.
 *
 * The panel is portalled to <body> with position:fixed off the button's rect, so a table's
 * overflow-x scroller cannot clip it. data-testid="popover" is the one the mock's assert reads. */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type PopKey =
  | "how" | "status" | "net" | "dpp" | "mem" | "dppTable" | "memTable" | "avg" | "rev" | "fields" | "gross" | "tax"
  | "fees" | "failed" | "venmo" | "unassigned" | "other" | "pace" | "matchmoney" | "paceChart"
  | "matchesMonth" | "matches4w" | "fieldCost4w" | "netTable" | "netSame" | "fieldCostDef";

/* ONE OR TWO SHORT SENTENCES EACH, 140 characters at most, no worked calculations and no pointers
 * to other pages (Ryan, 2026-10-08). The tiles' DPP and Membership are AFTER refunds; the city,
 * field and match tables' are BEFORE refunds, so each set has its own copy. */
export const POP: Record<PopKey, React.ReactNode> = {
  how: (<><div className="h">How we count revenue</div>Days are Central time. Test matches and internal accounts are left out.</>),
  status: (<><div className="h">Updating and final</div>A month is Updating until Stripe has synced its last day, about 2 days later. Then it is Final.</>),
  net: (<><div className="h">Net revenue</div>What customers paid, minus refunds, disputes and sales tax. Before Stripe fees.</>),
  dpp: (<><div className="h">DPP</div>Single match bookings and strike fees, after tax and refunds.</>),
  mem: (<><div className="h">Membership</div>Monthly membership charges, after tax and refunds. Most bill on the 1st.</>),
  dppTable: (<><div className="h">DPP</div>Before refunds and disputes, which come off in Net revenue.</>),
  memTable: (<><div className="h">Membership</div>Before refunds and disputes, which come off in Net revenue.</>),
  matchesMonth: (<><div className="h">Matches</div>Matches that have kicked off in the selected period.</>),
  matches4w: (<><div className="h">Matches, last 4 weeks</div>Matches played in the last 4 completed weeks, a Soccer Central match on both pitches counting as two.</>),
  fieldCost4w: (<><div className="h">Field cost / match</div>The field&apos;s cost per match. For profit share it is computed from the partner&apos;s terms and can differ from the billed amount on Field Costs. Profit share costs for the current month can still change until the month closes.</>),
  netTable: (<><div className="h">Net revenue</div>After refunds, disputes and sales tax. Hover a figure for its DPP and Membership.</>),
  avg: (<><div className="h">Avg daily DPP</div>DPP from completed days divided by the number of completed days.</>),
  rev: (<><div className="h">Refunds &amp; disputes</div>Money returned to customers, after the tax that came back with it. A dispute is a chargeback by the bank.</>),
  fields: (<><div className="h">Fields</div>Only fields that had revenue in the selected month and city.</>),
  gross: (<><div className="h">Gross collected</div>Every successful charge this month, including sales tax and hand-entered Venmo payments.</>),
  tax: (<><div className="h">Sales tax</div>Collected for the state, so it is not our revenue.</>),
  fees: (<><div className="h">Stripe fees</div>Card processing and billing fees. Not taken out of net revenue.</>),
  failed: (<><div className="h">Failed payments</div>Charges that looked successful but the bank reversed before they settled.</>),
  venmo: (<><div className="h">Venmo (manual)</div>Private rental payments received outside Stripe and entered by hand.</>),
  unassigned: (<><div className="h">Unassigned</div>Members with no city on file.</>),
  other: (<><div className="h">Other</div>Private rentals and charges that are neither DPP nor membership, after tax and refunds.</>),
  pace: (<><div className="h">Pace to month end</div>Revenue so far plus the recent daily average, adjusted for how last month trended, times the days left.</>),
  paceChart: (<><div className="h">Daily revenue pace</div>Each day&apos;s DPP and membership after sales tax, refunds and disputes, before Stripe fees. The same net basis as the tiles.</>),
  netSame: (<><div className="h">Revenue</div>Net revenue, after sales tax, refunds and disputes. Same as the Revenue page.</>),
  fieldCostDef: (<><div className="h">Field cost</div>The Field Costs rate × matches played, plus billed cancellations, plus profit-share payouts, in the month they were played.</>),
  matchmoney: (<><div className="h">DPP revenue per match</div>Each match&apos;s bookings less its refunds, after tax. Dated by kickoff.</>),
};

let closeOpen: (() => void) | null = null;

export function InfoI({ pop, label, large, testid, children }: {
  pop: PopKey; label: string; large?: boolean; testid?: string; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const place = useCallback(() => {
    const b = btn.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const W = Math.min(380, window.innerWidth - 32);
    setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(window.innerWidth - W - 8, r.left - 20)) });
  }, []);

  useEffect(() => {
    if (!open) return;
    if (closeOpen && closeOpen !== close) closeOpen();
    closeOpen = close;
    place();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => place();
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      if (closeOpen === close) closeOpen = null;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close, place]);

  return (
    <>
      <button ref={btn} type="button" className={large ? "i lg" : "i"} data-pop={pop}
        aria-expanded={open} aria-label={label} data-testid={testid}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((o) => !o); }}>i</button>
      {open && pos && createPortal(
        <div ref={panel} className="rv2-pop" role="dialog" aria-label={label} data-testid="popover"
          style={{ top: pos.top, left: pos.left }}>
          {POP[pop]}
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/* THE STYLES, GLOBAL AND PREFIXED. Global on purpose: the mock's assert reads row classes as exact
 * strings (`tr.className === "sub"`), and a CSS module or scoped styled-jsx would rename them. Every
 * selector is under .rv2 (or is the portalled .rv2-pop), so nothing leaks to other pages. */
export const RV2_CSS = `
.rv2 .num{font-variant-numeric:tabular-nums}
.rv2 .i{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;border:1px solid #c7d0ca;color:#7b8b82;
  font:italic 700 11px/1 Georgia,serif;cursor:pointer;background:#fff;vertical-align:middle;padding:0;flex:none}
.rv2 .i:hover,.rv2 .i[aria-expanded="true"]{color:#10231a;border-color:#46594e}
.rv2 .i.lg{width:20px;height:20px;font-size:13px}
.rv2-pop{position:fixed;z-index:60;width:min(380px,calc(100vw - 32px));background:#10231a;color:#fff;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.45;box-shadow:0 10px 30px rgba(0,0,0,.2)}
.rv2-pop b{color:#fff}
.rv2-pop ul{margin:6px 0 0;padding-left:16px;list-style:disc}
.rv2-pop li{margin-bottom:5px}
.rv2-pop .h{font-weight:800;margin-bottom:2px}
.rv2-pop table{margin-top:8px;width:100%;border-collapse:collapse}
.rv2-pop td{padding:2px 0}
.rv2-pop td+td{text-align:right;font-variant-numeric:tabular-nums}
.rv2-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rv2-head h2{margin:0;font-size:22px;font-weight:800;display:flex;align-items:center;gap:8px;color:#10231a}
.rv2 .status{border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700;background:#fff3d6;color:#7a5400;border:1px solid #f0d99a}
.rv2 .status.final{background:#e5f6ea;color:#14532d;border-color:#b7e3c4}
.rv2 .status.adjusted{background:#fdecea;color:#912018;border-color:#f3c3bd}
.rv2 .hero{padding:20px 22px;display:grid;gap:14px;background:#fff;border:1.5px solid var(--cream-line,#e6e2d8);border-radius:18px}
.rv2 .hero-top{display:grid;grid-template-columns:minmax(300px,380px) 1fr;gap:28px;align-items:stretch}
.rv2 .big .k{font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:#7b8b82;font-weight:700;display:flex;gap:6px;align-items:center}
.rv2 .big .v{font-size:40px;font-weight:800;line-height:1.1;margin-top:4px;color:#10231a}
.rv2 .calc{margin-top:10px;width:100%;display:grid;gap:2px;font-size:14px}
.rv2 .cl{display:flex;justify-content:space-between;gap:16px;padding:3px 0;color:#46594e}
.rv2 .cl span:first-child{display:flex;align-items:center;gap:6px}
.rv2 .cl.neg span:last-child{color:#b42318}
.rv2 .cl.tot{border-top:2px solid #10231a;margin-top:4px;padding-top:7px;color:#10231a;font-weight:800;font-size:16px}
.rv2 .cl.fee{margin-top:6px;color:#7b8b82;font-size:13px}
.rv2 .cl.fee span:last-child,.rv2 .cl.kept span:last-child{color:#7b8b82}
.rv2 .cl.kept{color:#7b8b82;font-size:13px}
.rv2 .toggle{margin:12px 0 0;border:1px solid #e2e7df;background:#fff;border-radius:999px;padding:6px 12px;font-weight:700;cursor:pointer;color:#10231a}
.rv2 .tiles{display:grid;gap:12px;align-content:stretch;grid-auto-rows:1fr}
.rv2 .tiles>.tile:last-child{grid-column:var(--last-span,auto)}
.rv2 .tile{background:#f6f8f5;border:1px solid #eef1ec;border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;justify-content:center;min-height:104px}
.rv2 .tile .k{font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#7b8b82;font-weight:700;display:flex;gap:6px;align-items:center}
.rv2 .tile .v{font-size:30px;font-weight:800;line-height:1.15;margin-top:6px;color:#10231a}
.rv2 .tile .s{font-size:12px;color:#7b8b82;margin-top:2px}
.rv2-title{margin:0 8px 0 0;font-size:30px;font-weight:800;display:flex;align-items:center;gap:8px;color:#10231a}
.rv2-status{display:inline-flex;align-items:center;gap:6px}
.rv2-filters{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.rv2-filters select{border:1px solid #e2e7df;border-radius:10px;padding:7px 10px;background:#fff;font:inherit;font-weight:600;color:#10231a;max-width:240px}
.rv2-filters select:disabled{opacity:.55}
.rv2-tag{display:inline-flex;align-items:center;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;background:#e5f6ea;color:#14532d;border:1px solid #b7e3c4;white-space:nowrap}
.rv2 table.items{border-collapse:collapse;width:100%;font-size:14px}
.rv2 table.items td{padding:8px 4px;border-bottom:1px solid #eef1ec}
.rv2 table.items td.amt{text-align:right;font-weight:600;width:140px}
.rv2 table.items td.cnt{color:#7b8b82;width:90px;text-align:right}
.rv2 table.items td.src{color:#7b8b82;font-size:12px;width:170px}
.rv2 table.items tr.sub td{font-weight:800;border-top:2px solid #e2e7df;background:#e5f6ea}
.rv2 table.items tr.sub2 td{font-weight:700;background:#f6f8f5}
.rv2 table.items .neg{color:#b42318}
.rv2 .lbl{display:inline-flex;align-items:center;gap:6px}
.rv2 .warn{border:1px solid #f3c3bd;background:#fdecea;color:#912018;border-radius:12px;padding:10px 14px;font-size:13px}
.rv2 table.city{border-collapse:collapse;width:100%;min-width:720px;font-size:13px}
.rv2 table.city th,.rv2 table.city td{padding:10px 12px;text-align:right;border-bottom:1px solid #eef1ec;white-space:nowrap}
.rv2 table.city th{font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:#7b8b82;font-weight:700}
.rv2 table.city th .lbl{justify-content:flex-end}
.rv2 table.city th.l,.rv2 table.city td.l{text-align:left}
.rv2 table.city th.l .lbl{justify-content:flex-start}
.rv2 table.city td.net{font-weight:800;background:#e5f6ea}
.rv2 table.city th.net{background:#e5f6ea;color:#14532d}
.rv2 table.city td.neg{color:#b42318}
.rv2 table.city tr.un td{color:#7b8b82;font-style:italic}
.rv2 table.city .w4{background:#f6f8fb}
.rv2 table.city .w4l{border-left:2px solid #c9d3e3}
.rv2 table.city tr.grp th{text-transform:none;letter-spacing:0;font-size:12px;color:#46594e;border-bottom:1px solid #e2e7df;padding-top:8px;padding-bottom:6px}
.rv2 table.city tr.grp th.w4{color:#24406b}
.rv2 table.city .sub{display:block;font-size:11px;font-weight:500;color:#7b8b82;text-transform:none;letter-spacing:0;font-style:normal;margin-top:2px}
.rv2 table.city .sub.tag{color:#8a6300;font-weight:700}
/* NARROWED (2026-10-09): fits 1,440 px; the first column is pinned when the box scrolls. */
.rv2 .nt-wrap{overflow-x:auto;max-width:100%}
.rv2 table.city.nt{min-width:0}
.rv2 table.city.nt th,.rv2 table.city.nt td{padding:9px 10px}
.rv2 table.city.nt .pin{position:sticky;left:0;z-index:1;background:#fff;box-shadow:1px 0 0 #e2e7df;white-space:normal;min-width:120px;max-width:200px}
.rv2 table.city.nt tr.tot .pin{background:#f6f8f5}
.rv2 table.city.nt tr.grp .pin{background:#fff}
.rv2 table.city.nt .nt-city{white-space:nowrap}
.rv2 table.city.nt thead tr:last-child th{white-space:normal;vertical-align:bottom;line-height:1.25}
.rv2 table.city.nt thead tr:last-child th .lbl{flex-wrap:wrap;row-gap:2px}
.rv2 table.city.nt .sub{white-space:normal;max-width:118px;margin-left:auto}
.rv2 table.city.nt tr.grp th.w4 .sub{max-width:none}
@media (max-width:760px){.rv2 table.city.nt{min-width:760px}.rv2 table.city.nt .pin{min-width:120px;max-width:150px}}
.rv2 table.city tr.tot td{font-weight:800;background:#f6f8f5;border-bottom:0}
.rv2 table.city tr.tot td.net{background:#d5f2de}
/* MONTHLY CARD + SORTABLE TABLES (2026-10-09) */
.rv2-mhead{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:6px}
.rv2-mtitle{margin:0;font-size:20px;font-weight:800;color:#10231a;letter-spacing:-.01em}
.rv2-launch{font-size:12px;font-weight:700;background:#fff6e3;color:#7a5200;border-radius:99px;padding:3px 10px;white-space:nowrap}
.rv2-grow{flex:1}
.rv2-range{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px solid #e2e7df;border-radius:12px;padding:3px 8px;background:#fff;font-size:13px}
.rv2-range select{border:0;background:none;font:inherit;font-weight:700;color:#10231a;padding:5px 2px;cursor:pointer}
.rv2-rlab{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#7b8b82;font-weight:700}
.rv2-pre{border:0;background:none;font:inherit;font-size:12px;font-weight:700;color:#5b7568;padding:6px 8px;border-radius:7px;cursor:pointer;min-height:32px}
.rv2-pre[aria-pressed=true]{background:#e5f6ea;color:#10231a}
.rv2-pre:disabled{opacity:.4;cursor:not-allowed}
.rv2-pre:focus-visible,.rv2 .nt-sort:focus-visible{outline:2px solid #2bd17e;outline-offset:1px}
.rv2 td.rv2-dim,.rv2 table.city td.dim{color:#b7c1bc}
.rv2 .nt-sort{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;border-radius:4px}
.rv2 .nt-sort .arr{font-size:9px;opacity:.25}
.rv2 .nt-sort .arr.on{opacity:1}
.rv2 table.city tbody tr.go{cursor:pointer}
.rv2 table.city tbody tr.go:hover td{background:#f7faf8}
.rv2 table.city tbody tr.go:hover td.net{background:#d9f1e1}
.rv2 table.city tbody tr.go:focus-visible{outline:2px solid #2bd17e;outline-offset:-2px}
@media (max-width:767px){.rv2 .big .v{font-size:32px}.rv2 .hero-top{grid-template-columns:1fr;gap:18px}.rv2 .tiles{grid-template-columns:1fr 1fr!important}.rv2 .tiles>.tile:last-child{grid-column:auto}.rv2 .tile .v{font-size:24px}.rv2 .hero{padding:16px}.rv2-title{font-size:24px}}
`;
