// ══════════════════════════════════════════════════════════════════════════════════════
// PROMO TIMES ARE TRUE UTC — the OPPOSITE model from the match screens. (Phase 18b)
//
//   THIS FILE:            promo startDateUtc / endDateUtc are GENUINE UTC instants. To show
//                         or enter one you convert through America/Chicago (the IANA zone,
//                         DST-aware — CDT −05:00 spring→fall, CST −06:00 fall→spring). Store
//                         and send the UTC instant.
//   src/lib/matchWallClock.ts:  the INVERSE. Match startDate/endDate wear a "Z" but are LOCAL
//                         WALL CLOCK; you must NOT convert them, only string-slice. See
//                         docs/matchday-api-facts.md "Dates: startDate/endDate are LOCAL
//                         WALL-CLOCK wearing a Z".
//
// The two bugs look identical and have INVERSE fixes. DO NOT import matchWallClock helpers
// here, and DO NOT import these there. Retool got this wrong — it displays every promo at a
// hardcoded −06:00, so it is one hour early during DST (~March–November). Clubhouse uses the
// IANA zone and is correct; it will disagree with Retool by an hour for most of the year. That
// is intended — do not "fix" it to match Retool.
// ══════════════════════════════════════════════════════════════════════════════════════

export const PROMO_TZ = "America/Chicago";
export const PROMO_TZ_LABEL = "America/Chicago (Central)";

type Wall = { y: number; mo: number; d: number; h: number; mi: number };

// The offset (ms that the zone is ahead of UTC) at a given UTC instant. Negative for Central
// (behind UTC). Uses Intl to read the DST-correct offset for THAT instant, so August returns
// −5h and December −6h off the same code.
function zoneOffsetMs(utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: PROMO_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const h = p.hour === "24" ? 0 : Number(p.hour); // Intl can emit "24" at midnight
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, Number(p.minute), Number(p.second));
  return asIfUtc - utcMs;
}

// A Chicago WALL clock (what the operator typed) -> the true UTC instant, as an ISO string.
// Two-pass so a value near a DST boundary lands on the right side. `sec` defaults to 0.
export function chicagoWallToUtcIso(w: Wall, sec = 0): string {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, sec); // pretend the wall time is UTC
  let utc = naive - zoneOffsetMs(naive);
  utc = naive - zoneOffsetMs(utc); // refine against the offset at the candidate instant
  return new Date(utc).toISOString();
}

// A true UTC instant (ISO) -> the Chicago wall-clock parts the operator should see.
export function utcIsoToChicagoWall(iso: string): Wall {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: PROMO_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(iso))) p[part.type] = part.value;
  const h = p.hour === "24" ? 0 : Number(p.hour);
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h, mi: Number(p.minute) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

// Human display, in Chicago. "Aug 10, 2026" / "8:45 AM" / "Aug 10, 2026 8:45 AM".
export function fmtChicagoDate(iso: string): string { const w = utcIsoToChicagoWall(iso); return `${MONTHS[w.mo - 1]} ${w.d}, ${w.y}`; }
export function fmtChicagoTime(iso: string): string {
  const w = utcIsoToChicagoWall(iso);
  const ap = w.h >= 12 ? "PM" : "AM", hh = w.h % 12 === 0 ? 12 : w.h % 12;
  return `${hh}:${pad(w.mi)} ${ap}`;
}
export function fmtChicagoFull(iso: string): string { return `${fmtChicagoDate(iso)} ${fmtChicagoTime(iso)}`; }

// <input type="date"> / <input type="time"> values (Chicago wall) <-> UTC instant.
export function toChicagoInputs(iso: string): { date: string; time: string } {
  const w = utcIsoToChicagoWall(iso);
  return { date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`, time: `${pad(w.h)}:${pad(w.mi)}` };
}
export function fromChicagoInputs(date: string, time: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return chicagoWallToUtcIso({ y, mo, d, h, mi });
}

// ── the two form defaults (Phase 18b R2e), both proven as test cases ──
// "next quarter hour" from a given now: round the Chicago minute UP to the next :00/:15/:30/:45
// (+1 so exactly-on-the-quarter still advances), then convert that Chicago wall time to UTC.
export function nextQuarterHourUtcIso(nowUtcMs: number): string {
  const w = utcIsoToChicagoWall(new Date(nowUtcMs).toISOString());
  let mi = Math.ceil((w.mi + 1) / 15) * 15;
  let h = w.h, d = w.d, mo = w.mo, y = w.y;
  if (mi >= 60) { mi -= 60; h += 1; }
  if (h >= 24) { h -= 24; d += 1; } // rare cross-midnight; the ISO round-trip normalises the date
  return chicagoWallToUtcIso({ y, mo, d, h, mi });
}
// "end of this year": Dec 31 23:59 Chicago of the given year -> UTC.
export function endOfYearUtcIso(chicagoYear: number): string {
  return chicagoWallToUtcIso({ y: chicagoYear, mo: 12, d: 31, h: 23, mi: 59 });
}
// The Chicago calendar year of a UTC instant (for "end of THIS year" off `now`).
export function chicagoYearOf(nowUtcMs: number): number {
  return utcIsoToChicagoWall(new Date(nowUtcMs).toISOString()).y;
}
