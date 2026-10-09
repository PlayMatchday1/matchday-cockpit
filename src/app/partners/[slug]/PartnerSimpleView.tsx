// THE SIMPLE PARTNER PAGE (Ryan, 2026-10-09) — rendered only for a partner whose
// partner_dashboards.layout is 'simple' (migration 0217). A separate component on purpose: the shared
// views (PartnerMonthlyView, PartnerDashboardV14, PartnerRentalView) are untouched, so no other
// partner's page changes. Data: src/lib/partnerSimpleDashboard.ts, which adds no arithmetic.

import type { PartnerSimpleProps } from "@/lib/partnerSimpleDashboard";

const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dfull = (ymd: string) => `${MONS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;
const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
const money2 = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const num = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US"));

export default function PartnerSimpleView(p: PartnerSimpleProps) {
  const c = p.current;
  const Unit = p.unit === "week" ? "week" : "month";
  const showAll = p.months.length >= 2;
  const sum = (f: (m: PartnerSimpleProps["months"][number]) => number | null) => p.months.reduce((s, m) => s + (f(m) ?? 0), 0);

  return (
    <div className="psv" data-testid="partner-simple">
      <style>{CSS}</style>
      <header className="psv-head">
        <h1>{p.partnerName}</h1>
        <div className="psv-meta">{[p.city, "partner dashboard", `updated ${dfull(p.updated)}`].filter(Boolean).join(" · ")}</div>
        <p className="psv-deal" data-testid="psv-deal">{p.deal}</p>
      </header>

      {c && (
        <section className="psv-cards" aria-label={`This ${Unit}`}>
          <div className="psv-card psv-main" data-testid="psv-share">
            <div className="psv-cl">{c.isOpen ? "Your share so far" : "Your share"}</div>
            <div className="psv-cv">{money2(c.shareSoFar)}</div>
            <div className="psv-cn">{p.sharePct}% of {money(c.revenue)}.{c.isOpen && c.closes ? ` Final on ${dfull(c.closes)}.` : ""}</div>
          </div>
          <div className="psv-card" data-testid="psv-revenue">
            <div className="psv-cl">Player revenue</div>
            <div className="psv-cv">{money(c.revenue)}</div>
            <div className="psv-cn">{c.label}{c.isOpen ? " so far" : ""}</div>
          </div>
          <div className="psv-card" data-testid="psv-matches">
            <div className="psv-cl">Matches</div>
            <div className="psv-cv">{num(c.matches)}</div>
            <div className="psv-cn">{num(c.spots)} spots filled, {num(c.players)} different {c.players === 1 ? "player" : "players"}</div>
          </div>
        </section>
      )}

      <section className="psv-tablecard">
        <h2>By {Unit}</h2>
        <div className="psv-scroll">
          <table data-testid="psv-table">
            <thead><tr>
              <th>{Unit === "week" ? "Week" : "Month"}</th><th className="n">Matches</th><th className="n">Spots</th>
              <th className="n">Revenue</th><th className="n">Your {p.sharePct}%</th><th>Status</th>
            </tr></thead>
            <tbody>
              {p.months.map((m) => (
                <tr key={m.key} className={m.isOpen ? "open" : ""}>
                  <td>{m.label}</td>
                  <td className="n">{num(m.matches)}</td>
                  <td className="n">{num(m.spots)}</td>
                  <td className="n">{money(m.revenue)}</td>
                  <td className="n">{money2(m.share)}{m.diverged && <span className="psv-sub">Figures changed after payment; the paid amount stands.</span>}</td>
                  <td>{m.status}</td>
                </tr>
              ))}
            </tbody>
            {showAll && (
              <tfoot><tr>
                <td>All time</td>
                <td className="n">{num(sum((m) => m.matches))}</td>
                <td className="n">{num(sum((m) => m.spots))}</td>
                <td className="n">{money(sum((m) => m.revenue))}</td>
                <td className="n">{money2(sum((m) => m.share))}</td>
                <td />
              </tr></tfoot>
            )}
          </table>
        </div>
      </section>

      <details className="psv-how" data-testid="psv-how">
        <summary>How this is calculated</summary>
        <ul>
          <li>Revenue is what players paid to book, before sales tax.</li>
          <li>Spots cancelled within 24 hours of a match are not refunded, so they count.</li>
          {c?.memberRateCents != null && (
            <li>Members&apos; spots count at the average drop-in price: ${(c.memberRateCents / 100).toFixed(2)} this {Unit}
              {c.memberRateSource?.kind === "avg" ? `, the average of ${num(c.memberRateSource.dropIns)} drop-ins.`
                : c.memberRateSource?.kind === "current" ? ", the current match price, as there were no drop-ins yet." : "."}</li>
          )}
        </ul>
      </details>

      <a className="psv-wrong" href="mailto:ryan@playmatchday.com?subject=Partner%20payment%20question">Something look wrong? Tell us</a>
    </div>
  );
}

const CSS = `
.psv{--forest:#003326;--ink:#0d1f18;--muted:#5C6B62;--line:#E3E8E0;--slot:#F7F9F6;--mint:#E9FAF1;--mintEdge:#A8E7C9;
  max-width:1100px;margin:0 auto;padding:0 16px 40px;color:var(--ink);font-variant-numeric:tabular-nums;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
.psv *{box-sizing:border-box}
.psv-head{padding:28px 0 18px}
.psv-head h1{margin:0;font-size:30px;font-weight:900;letter-spacing:-.6px;color:var(--forest)}
.psv-meta{margin-top:6px;font-size:13px;color:var(--muted)}
.psv-deal{margin:14px 0 0;font-size:16px;line-height:1.5;color:var(--ink);max-width:640px}
.psv-cards{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:14px;margin:6px 0 22px}
.psv-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;box-shadow:0 6px 20px rgba(0,43,34,.06)}
.psv-main{background:var(--forest);border-color:var(--forest);color:#fff}
.psv-cl{font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--muted)}
.psv-main .psv-cl{color:#A8E7C9}
.psv-cv{font-size:30px;font-weight:900;letter-spacing:-.6px;margin-top:8px;color:var(--forest)}
.psv-main .psv-cv{font-size:40px;color:#fff}
.psv-cn{font-size:13px;color:var(--muted);margin-top:6px;line-height:1.4}
.psv-main .psv-cn{color:#DCEFE6}
.psv-tablecard{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;margin-bottom:16px}
.psv-tablecard h2{margin:0;padding:16px 20px;font-size:15px;font-weight:900;color:var(--forest);border-bottom:1px solid var(--line)}
.psv-scroll{overflow-x:auto}
.psv table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px}
.psv th{text-align:left;font-size:10.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:10px 16px;background:var(--slot);border-bottom:1px solid var(--line);white-space:nowrap}
.psv td{padding:11px 16px;border-bottom:1px solid #EEF2EC;vertical-align:top}
.psv .n{text-align:right;white-space:nowrap}
.psv tr.open td{background:var(--mint)}
.psv tfoot td{font-weight:800;background:var(--slot);border-top:1px solid var(--line);border-bottom:0}
.psv-sub{display:block;font-size:11px;font-weight:400;color:var(--muted);white-space:normal;margin-top:2px}
.psv-how{background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px 20px;margin-bottom:14px}
.psv-how summary{cursor:pointer;font-weight:800;color:var(--forest);font-size:14px}
.psv-how ul{margin:10px 0 2px;padding-left:18px;font-size:13.5px;line-height:1.6;color:var(--ink)}
.psv-wrong{display:inline-block;font-size:13px;font-weight:700;color:var(--forest);text-decoration:underline;text-underline-offset:2px;padding:6px 0}
@media (max-width:760px){
  .psv-cards{grid-template-columns:1fr}
  .psv-head h1{font-size:26px}
  .psv-main .psv-cv{font-size:34px}
}
`;
