// WHICH FINANCE PAGES DRAW THEIR OWN HEADER (Ryan, 2026-10-03).
//
// The Finance shell draws the large "FINANCE" title and the period bar (Month / Quarter / Year,
// the partial-days chip) above every section. OpEx is always ONE month and carries its own
// "‹ October 2026 › · This month" beside its heading instead, so the shell leaves both out there.
// Every other Finance page keeps them unchanged. "Last synced" stays on every page; on these pages
// it is drawn small.
//
// A replaced instruction said to keep the Finance period control on OpEx and leave arrows out.

// Expenses joined OpEx on 2026-10-03: one month, its own arrows (Ryan).
// Revenue joined on 2026-10-07: "Revenue" is the heading, with the same period bar beside it (all
// three grains), and one status pill in place of the partial-days chip (Ryan).
// Cost and Cities joined on 2026-10-10: the page name, then the same pinned bar as Revenue
// (FinancePageBar), with their own City (and, on Cost, Field) selects (Ryan).
// Staff Credits joined on 2026-10-21: it has its own From / To range, so the shell's period bar would
// be a control that does nothing there.
export const OWN_HEADER_SECTIONS: ReadonlySet<string> = new Set(["/admin/finance/opex", "/admin/finance/ledger/expenses", "/admin/finance/revenue", "/admin/finance/cost", "/admin/finance/cities", "/admin/finance/staff-credits"]);

export const drawsOwnHeader = (pathname: string): boolean => OWN_HEADER_SECTIONS.has(pathname);
