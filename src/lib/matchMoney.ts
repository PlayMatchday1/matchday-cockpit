// Cents <-> dollars for the match editors. Prices are integer CENTS on the API
// (docs/matchday-api-facts.md). One shared pair so the display and the parse can't
// drift, and so the integer round-trips exactly (12000 -> "120.00" -> 12000).
export const centsToDollars = (c: unknown): string => (Number(c ?? 0) / 100).toFixed(2);
export const dollarsToCents = (d: string): number => Math.round(parseFloat(d) * 100);
