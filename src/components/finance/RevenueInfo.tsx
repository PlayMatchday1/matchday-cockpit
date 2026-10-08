"use client";

/* THE REVENUE PAGE'S INFO POPOVERS — the mock's words (scripts/mocks/finance-revenue-v2.html,
 * <template id="t-…">), verbatim, and the mock's behaviour: click opens, a second click on the same
 * i closes, a click anywhere else or Esc closes, and only one is ever open.
 *
 * The panel is portalled to <body> with position:fixed off the button's rect, so a table's
 * overflow-x scroller cannot clip it. data-testid="popover" is the one the mock's assert reads. */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type PopKey =
  | "how" | "status" | "net" | "dpp" | "mem" | "avg" | "rev" | "fields" | "gross" | "tax"
  | "fees" | "failed" | "venmo" | "unassigned" | "other" | "pace" | "matchmoney";

export const POP: Record<PopKey, React.ReactNode> = {
  how: (<><div className="h">How we count revenue</div><ul>
    <li>Days and months are <b>Central time</b>. A charge at 9pm on Sep 30 counts in September.</li>
    <li><b>Net revenue</b> is what customers paid, minus refunds, disputes and sales tax.</li>
    <li>Refunds and disputes count in the month they happen, even if the original charge was earlier.</li>
    <li>Sales tax is calculated from each city&apos;s rate (Texas 8.25%).</li>
    <li>Stripe fees are shown separately and are not taken out of net revenue.</li>
    <li>Includes Venmo payments for private rentals, entered by hand.</li>
    <li>Excludes test matches and internal accounts.</li>
    <li>Members with no city on file are shown as Unassigned, so cities always add up to the total.</li>
    <li>A month shows <b>Updating</b> until Stripe&apos;s data for its last day has synced, about 2 days later, then <b>Final</b>.</li>
  </ul></>),
  status: (<><div className="h">Updating and final</div>Stripe makes each day&apos;s payments available by noon the next day, so the last days of a month can still be arriving. September shows <b>Updating</b> until Sep 30 has fully synced, then <b>Final</b>. A final month does not change on its own: new refunds and disputes count in the month they happen. If anything is entered or edited for a final month later, such as a Venmo rental, it shows <b>Adjusted after final</b> with the amount.</>),
  net: (<><div className="h">Net revenue</div>Everything customers paid in the month (Stripe and Venmo), minus refunds, failed payments, disputes and sales tax. It is the money that is ours before Stripe&apos;s fees.</>),
  dpp: (<><div className="h">DPP</div>Drop-in pay-per-play: single match bookings and strike fees. Net of sales tax. In the tiles and the four-month table it is also after its own refunds and disputes, so DPP + Membership + Other = Net revenue; the city and field tables show refunds and disputes in their own column instead.</>),
  mem: (<><div className="h">Membership</div>Monthly membership charges. Most bill on the 1st; members who joined mid-month bill on their own date. Net of sales tax, and in the tiles and the four-month table after membership refunds and disputes. On the Field tab, a city&apos;s membership is credited to its fields by their share of the city&apos;s member spots that month, the rule the Cities page uses.</>),
  avg: (<><div className="h">Avg daily DPP</div>DPP for the month divided by the days in it. Membership is left out because most of it bills on the 1st and would distort a daily average.</>),
  rev: (<><div className="h">Refunds &amp; disputes</div>Money returned to customers this month, net of the tax that came back with it. A dispute is a chargeback: the cardholder&apos;s bank reversed the payment. Each dispute also costs a $15 Stripe fee, shown under Stripe fees. <b>Every refund and dispute figure on this page is net of tax</b>, so Sales tax is the tax on the month&apos;s charges.</>),
  fields: (<><div className="h">Fields</div>Lists only real fields that had revenue in the selected month and city, matched by field ID, not by match name.</>),
  gross: (<><div className="h">Gross collected</div>Every successful charge in the month, including sales tax, plus Venmo payments entered by hand.</>),
  tax: (<><div className="h">Sales tax</div>Collected from customers on behalf of the state, so it is not our revenue. Calculated per city from its rate, on the month&apos;s charges. The tax returned with a refund is already out of the refund figure.</>),
  fees: (<><div className="h">Stripe fees</div>Card processing, invoicing and billing fees, and dispute fees, as Stripe reports them for the month.</>),
  failed: (<><div className="h">Failed payments</div>Charges that looked successful and were later reversed by the bank before settling.</>),
  venmo: (<><div className="h">Venmo (manual)</div>Private rental payments received outside Stripe and entered by hand.</>),
  // ── Not in the mock: the build's own, where the mock had nothing to say ──
  unassigned: (<><div className="h">Unassigned</div>Payments whose member has no city on file: the account was deleted, or the email matches no member. They stay in the total so the cities add up. Sales tax is taken at the Texas rate, 8.25%.</>),
  other: (<><div className="h">Other</div>Private rentals (Venmo and Stripe) and charges that are neither DPP nor membership, net of tax and of their own refunds. In the city and field tables they count in the row&apos;s net revenue but have no column of their own.</>),
  pace: (<><div className="h">Pace to month end</div>Net revenue so far, plus the days left × a daily rate. The rate is net revenue so far less day 1 (when most memberships bill) and less today (still arriving), divided by the days that leaves. Day 1 and today are still counted in the total; they are only left out of the rate.</>),
  matchmoney: (<><div className="h">DPP revenue per match</div>From Stripe: each match&apos;s charges, less its refunds and disputes, net of sales tax. Joined to the match by the payment, not by name. Dated by kick-off, so a total here is not a month&apos;s net revenue.</>),
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
.rv2 table.city tr.tot td{font-weight:800;background:#f6f8f5;border-bottom:0}
.rv2 table.city tr.tot td.net{background:#d5f2de}
@media (max-width:767px){.rv2 .big .v{font-size:32px}.rv2 .hero-top{grid-template-columns:1fr;gap:18px}.rv2 .tiles{grid-template-columns:1fr 1fr!important}.rv2 .tiles>.tile:last-child{grid-column:auto}.rv2 .tile .v{font-size:24px}.rv2 .hero{padding:16px}.rv2-title{font-size:24px}}
`;
