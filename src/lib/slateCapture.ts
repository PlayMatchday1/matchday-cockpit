// Slate Review meeting quick-capture parser — pure, in-memory, no writes.
// Typing "8PM thurs Crossbar" becomes a dashed NEW proposal on the grid; anything
// missing a time, a day, OR a field is kept verbatim as a note (two of three is a
// note, not a guess). Field aliases/short codes are derived from the actual field
// list for the city at runtime; an alias that matches two fields is dropped, not
// guessed. Every rule here is printed on the page as CAPTURE_GRAMMAR so the parser
// is predictable.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Day = (typeof DAYS)[number];

const DAY_ALIASES: Record<string, Day> = {
  mon: "Mon", monday: "Mon", tue: "Tue", tues: "Tue", tuesday: "Tue",
  wed: "Wed", weds: "Wed", wednesday: "Wed", thu: "Thu", thur: "Thu", thurs: "Thu", thursday: "Thu",
  fri: "Fri", friday: "Fri", sat: "Sat", saturday: "Sat", sun: "Sun", sunday: "Sun",
};

export const CAPTURE_GRAMMAR =
  "A time, a day and a field — like “8PM thurs Crossbar” — becomes a proposal on that day. " +
  "All three must be present; two of the three is kept as a note, word for word. " +
  "A bare hour of 1–11 is read as PM (it says so). Field names, short codes and initials are " +
  "matched against this city’s fields; an alias that fits two fields is left as typed. Nothing is discarded.";

// minutes-past-midnight, so "10 PM" sorts after "7 PM".
export function timeMinutes(t: string): number {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(t.trim());
  if (!m) return 0;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + (m[2] ? Number(m[2]) : 0);
}

// Short field codes derived from names: initials of the first ≤3 words, then all
// initials, then the full name — first non-colliding candidate wins. Never a
// hand-kept list.
export function deriveFieldCodes(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of fields) {
    const words = f.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
    const cands = [
      words.slice(0, 3).map((w) => w[0]).join(""),
      words.map((w) => w[0]).join(""),
      f,
    ];
    let picked = f.toUpperCase();
    for (const c of cands) {
      const up = c.toUpperCase();
      if (up && !used.has(up)) { picked = up; break; }
    }
    used.add(picked);
    out[f] = picked;
  }
  return out;
}

// Build alias → field, dropping any alias that maps to more than one field.
function buildAliasMap(fields: string[], codes: Record<string, string>): Map<string, string | null> {
  const counts = new Map<string, Set<string>>();
  const add = (alias: string, field: string) => {
    const key = alias.toLowerCase();
    if (!key) return;
    if (!counts.has(key)) counts.set(key, new Set());
    counts.get(key)!.add(field);
  };
  for (const f of fields) {
    add(f, f); // full name
    add(codes[f], f); // derived code
    const words = f.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w) && w.length >= 3);
    for (const w of words) add(w, f); // each significant word (e.g. "Crossbar")
  }
  const map = new Map<string, string | null>();
  for (const [alias, set] of counts) map.set(alias, set.size === 1 ? [...set][0] : null); // ambiguous → null
  return map;
}

export type Capture =
  | { kind: "note"; raw: string }
  | {
      kind: "slot"; raw: string; day: Day; time: string; min: number;
      hourTxt: string; assumed: boolean; field: string | null; fieldTxt: string; unknown: boolean;
    };

// Parse one line against a city's field list. Returns null for empty input.
export function parseCapture(raw: string, fields: string[]): Capture | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const codes = deriveFieldCodes(fields);
  const aliases = buildAliasMap(fields, codes);

  const tokens = trimmed.split(/\s+/);
  const remaining: string[] = [];
  let day: Day | null = null;
  let time: string | null = null;
  let hourTxt = "";
  let assumed = false;

  for (const tok of tokens) {
    const low = tok.toLowerCase().replace(/[.,]/g, "");
    if (!day && DAY_ALIASES[low]) { day = DAY_ALIASES[low]; continue; }
    // time with explicit am/pm, e.g. 8pm, 8:30pm, 8 pm (space handled by token loop)
    const tm = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/i.exec(low);
    if (!time && tm) {
      const h = Number(tm[1]);
      const min = tm[2] ? tm[2] : "00";
      const ap = tm[3].toUpperCase();
      if (h >= 1 && h <= 12) { time = `${h}:${min} ${ap}`; continue; }
    }
    // bare hour 1–11 → PM (assumed)
    if (!time && /^\d{1,2}$/.test(low)) {
      const h = Number(low);
      if (h >= 1 && h <= 11) { time = `${h}:00 PM`; hourTxt = tok; assumed = true; continue; }
    }
    remaining.push(tok);
  }

  if (!day || !time) return { kind: "note", raw: trimmed };

  const fieldTxtRaw = remaining.join(" ").trim();
  if (!fieldTxtRaw) return { kind: "note", raw: trimmed };

  // Resolve the field text against the alias map (try the whole thing, then each token).
  let field: string | null = null;
  const whole = aliases.get(fieldTxtRaw.toLowerCase());
  if (whole) field = whole;
  else {
    for (const tok of remaining) {
      const hit = aliases.get(tok.toLowerCase().replace(/[.,]/g, ""));
      if (hit) { field = hit; break; }
      if (hit === null) { field = null; break; } // ambiguous token → leave as typed
    }
  }

  return {
    kind: "slot", raw: trimmed, day, time, min: timeMinutes(time),
    hourTxt: hourTxt || time, assumed,
    field, fieldTxt: field ? field : fieldTxtRaw, unknown: !field,
  };
}

// The readout under the input, mirroring the mockup's phrasing.
export function captureReadout(p: Capture | null): string {
  if (!p) return "";
  if (p.kind === "note") return "No time and day in that, so Enter keeps it as a note, word for word.";
  let out = `${p.day} ${p.time} · ${p.fieldTxt} — Enter adds it to ${p.day}.`;
  if (p.assumed) out += ` Read ${p.hourTxt} as ${p.time}, because every slot here is an evening slot.`;
  if (p.unknown) out += ` “${p.fieldTxt}” is not a field I know here, so it goes on exactly as typed.`;
  return out;
}
