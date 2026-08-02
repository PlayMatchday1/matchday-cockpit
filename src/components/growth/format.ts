// Formatting + CSV helpers for the Growth dashboard. Kept tiny and dependency-free.

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtMoney(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x == null) return "—";
  return (x * 100).toFixed(digits) + "%";
}

// PART 9: pluralise carefully — never blindly suffix "s".
export function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : pluralForm ?? singular + "s";
}
export function countLabel(n: number, singular: string, pluralForm?: string): string {
  return `${fmtInt(n)} ${plural(n, singular, pluralForm)}`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MON[m - 1]} ${y}`;
}
export function monthShort(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MON[m - 1]} '${String(y).slice(2)}`;
}

// CSV: quote every field, escape embedded quotes, CRLF rows (Excel-friendly).
function csvCell(v: string | number): string {
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
export function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
