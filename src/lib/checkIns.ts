// City Manager Check-Ins data layer.
//
// Reads live from the published Google Sheet that the standalone
// city-managers-dashboard HTML uses. No Supabase tables, no Form
// ingestion — the Sheet stays the source of truth and managers keep
// using the existing Google Form. CORS is open on the publish URL,
// so fetch happens client-side from the browser.

export type Manager = {
  name: string;
  city: string; // Sheet/standalone label (e.g. "North Austin", "DFW", "St Louis")
  payDay: number; // day of month
  amount: number; // monthly $
};

// 7 city managers, copied verbatim from the standalone HTML's
// MANAGERS array. Mirror this when the form/Sheet manager universe
// changes — the Sheet is read live but this list drives the calendar
// rows, payment cards, and the one-card-per-manager grid.
export const MANAGERS: Manager[] = [
  { name: "Yarra", city: "Houston", payDay: 5, amount: 500 },
  { name: "Abraham", city: "San Antonio", payDay: 15, amount: 500 },
  { name: "Gabe", city: "North Austin", payDay: 15, amount: 500 },
  { name: "Willfried", city: "St Louis", payDay: 5, amount: 500 },
  { name: "Anton", city: "El Paso", payDay: 11, amount: 500 },
  { name: "Chris", city: "DFW", payDay: 15, amount: 800 },
  { name: "Rodrigo", city: "OKC", payDay: 1, amount: 500 },
];

export const CHECK_INS_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQmzasZGvZavVJan2QFpMxWuhc7HNzWIxRKcx1VsQS7jUZej13C9ODkhN1bw1NFOSUa2fgHKYfySrIE/pub?output=csv";

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// Next pay date relative to `today` — this month's pay day if it
// hasn't passed, otherwise next month's. Clamps the day to the
// month's actual length (e.g. payDay=31 in February → Feb 28).
export function getNextPayDate(payDay: number, today: Date): Date {
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayThisMonth = Math.min(payDay, daysInMonth(today.getFullYear(), today.getMonth()));
  const thisMonthPay = new Date(today.getFullYear(), today.getMonth(), dayThisMonth);
  if (thisMonthPay >= todayMid) return thisMonthPay;
  const nextMonth = today.getMonth() === 11 ? 0 : today.getMonth() + 1;
  const nextYear = today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
  const dayNextMonth = Math.min(payDay, daysInMonth(nextYear, nextMonth));
  return new Date(nextYear, nextMonth, dayNextMonth);
}

export function daysUntil(date: Date, today: Date): number {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((d.getTime() - t.getTime()) / (1000 * 60 * 60 * 24));
}

export function formatMonthDay(d: Date): string {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

export function formatMoney(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

export type CheckInEntry = {
  timestamp: Date;
  city: string; // raw city from Sheet
  rating: number; // parsed; 0 if missing or invalid
  win: string;
  challenge: string;
  focus: string;
  fieldsContacted: string;
  fieldsList: string;
  fieldProgress: string;
  matchManager: string;
  marketingChannels: string;
  marketingResults: string;
};

export type ManagerStatus = {
  manager: Manager;
  entry: CheckInEntry | null; // latest submission ever, regardless of month
  submitted: boolean; // entry exists AND timestamp >= 1st of current calendar month
};

export type CheckInsData = {
  statuses: ManagerStatus[];
  submittedCount: number;
  overdueCount: number; // = total − submitted (matches standalone semantics)
};

// CSV parser ported verbatim from the standalone — handles quoted
// fields, escaped quotes, CRLF, and embedded commas.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Flexible column matcher — finds a column index by keyword match
// on lowercased headers. First matching keyword wins.
export function findCol(headers: string[], keywords: string[]): number {
  const lower = headers.map((h) => (h || "").toLowerCase());
  for (const kw of keywords) {
    const idx = lower.findIndex((h) => h.includes(kw.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Loose city match — handles DFW↔Dallas, North Austin↔Austin,
// OKC↔Oklahoma. Mirrors the standalone's matcher exactly.
function cityMatch(sheetCity: string, managerCity: string): boolean {
  const cl = sheetCity.toLowerCase();
  const ml = managerCity.toLowerCase();
  if (cl === ml) return true;
  if (cl.includes(ml) || ml.includes(cl)) return true;
  if (ml === "dfw" && (cl.includes("dallas") || cl.includes("fort worth"))) {
    return true;
  }
  if (ml === "north austin" && cl.includes("austin")) return true;
  if (ml === "okc" && cl.includes("oklahoma")) return true;
  return false;
}

export async function fetchCheckIns(): Promise<CheckInsData> {
  const url = CHECK_INS_SHEET_URL + "&_t=" + Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text);
  return buildCheckInsData(rows, new Date());
}

// Pure transformer split out for testability and so the hook can
// inject a fake `now` if needed.
export function buildCheckInsData(rows: string[][], now: Date): CheckInsData {
  if (rows.length < 2) {
    return {
      statuses: MANAGERS.map((m) => ({
        manager: m,
        entry: null,
        submitted: false,
      })),
      submittedCount: 0,
      overdueCount: MANAGERS.length,
    };
  }

  const headers = rows[0];
  const data = rows.slice(1).filter((r) => r.some((c) => c && c.trim()));

  const idx = {
    timestamp: findCol(headers, ["timestamp"]),
    city: findCol(headers, ["city"]),
    rating: findCol(headers, ["rating", "overall"]),
    fieldsContacted: findCol(headers, [
      "new fields contacted",
      "fields contacted",
    ]),
    fieldsList: findCol(headers, ["list of fields"]),
    fieldProgress: findCol(headers, ["progress update", "field relationships"]),
    matchMgr: findCol(headers, ["match manager"]),
    marketingEfforts: findCol(headers, ["grassroots", "marketing efforts"]),
    marketingResults: findCol(headers, [
      "results from",
      "marketing results",
    ]),
    win: findCol(headers, ["biggest win"]),
    challenge: findCol(headers, ["biggest challenge"]),
    focus: findCol(headers, ["primary focus", "focus for next"]),
  };

  const get = (row: string[], i: number) =>
    i >= 0 ? (row[i] || "").trim() : "";

  // Latest submission per raw Sheet city.
  type Acc = { ts: Date; row: string[] };
  const latestByCity = new Map<string, Acc>();
  for (const row of data) {
    const cityRaw = idx.city >= 0 ? row[idx.city] : "Unknown";
    const tsRaw = idx.timestamp >= 0 ? row[idx.timestamp] : "";
    const ts = tsRaw ? new Date(tsRaw) : new Date(0);
    if (Number.isNaN(ts.getTime())) continue;
    const cur = latestByCity.get(cityRaw);
    if (!cur || ts > cur.ts) {
      latestByCity.set(cityRaw, { ts, row });
    }
  }

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const statuses: ManagerStatus[] = MANAGERS.map((m) => {
    let match: Acc | null = null;
    for (const [cityRaw, acc] of latestByCity) {
      if (cityMatch(cityRaw, m.city)) {
        match = acc;
        break;
      }
    }
    if (!match) return { manager: m, entry: null, submitted: false };
    const r = match.row;
    const ratingRaw = get(r, idx.rating);
    const ratingNum = parseFloat(ratingRaw);
    const entry: CheckInEntry = {
      timestamp: match.ts,
      city: idx.city >= 0 ? r[idx.city] : "",
      rating: Number.isFinite(ratingNum) ? ratingNum : 0,
      win: get(r, idx.win),
      challenge: get(r, idx.challenge),
      focus: get(r, idx.focus),
      fieldsContacted: get(r, idx.fieldsContacted),
      fieldsList: get(r, idx.fieldsList),
      fieldProgress: get(r, idx.fieldProgress),
      matchManager: get(r, idx.matchMgr),
      marketingChannels: get(r, idx.marketingEfforts),
      marketingResults: get(r, idx.marketingResults),
    };
    return { manager: m, entry, submitted: match.ts >= monthStart };
  });

  const submittedCount = statuses.filter((s) => s.submitted).length;
  return {
    statuses,
    submittedCount,
    overdueCount: statuses.length - submittedCount,
  };
}
