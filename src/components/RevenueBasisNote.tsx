/* ONE LINE, SAME WORDS, SAME PLACE — which tax basis the revenue on this page is on.
 *
 * THE ESTATE KEEPS TWO, DELIBERATELY:
 *
 *   TAX-INCLUSIVE   fin_revenue as recorded — the Stripe charge, sales tax included. Finance ›
 *                   Revenue and Finance › Cities report money COLLECTED and tie to Stripe's gross
 *                   volume, so they are on this basis on purpose.
 *   PRE-TAX         mdapi_match_players.amount — the price before the 8.25-9.68% the city charges.
 *                   Slate Review, Match P&L, the Player Data Room and Finance › Cost are here,
 *                   because each divides or compares against roster-derived money.
 *
 * WHY THE LABEL EXISTS RATHER THAN A RECONCILIATION. The two bases differ by roughly 8%, which is
 * small enough to look like a rounding argument and large enough to change a decision. A reader
 * comparing the Revenue page to the Cost page will find ~8% they cannot account for, and without
 * this line the only way to learn why is to read four files.
 *
 * THE PLAYER DATA ROOM'S PRE-TAX HISTORY CANNOT BE MADE TAX-INCLUSIVE. total_amount is only
 * populated from 2025-12; before that the column is 0 for all 87,160 rows. That gap is permanent
 * until someone decides otherwise, which is its own reason for the label to be a fact on the page
 * rather than a promise to align later.
 */

export type RevenueBasis = "pre-tax" | "tax-inclusive";

const COPY: Record<RevenueBasis, string> = {
  "pre-tax": "Revenue on this page is PRE-TAX — the price before city sales tax.",
  "tax-inclusive": "Revenue on this page is TAX-INCLUSIVE — the Stripe charge, sales tax included.",
};

export default function RevenueBasisNote({ basis }: { basis: RevenueBasis }) {
  return (
    <p className="rbn" data-testid="revenue-basis" data-basis={basis}>
      {COPY[basis]}
      <style jsx>{`
        .rbn {
          margin: 6px 0 0;
          font-size: 12px;
          color: #6E8076;
          letter-spacing: 0.01em;
        }
      `}</style>
    </p>
  );
}
