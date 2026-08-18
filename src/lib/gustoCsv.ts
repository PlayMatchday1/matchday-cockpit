// Gusto payroll CSV — pure builders + safety checks. No React, no I/O, so
// every branch is unit-testable. A wrong mapping here pays the wrong person
// and the CSV still looks fine, so the duplicate-name check and the
// alias-verbatim rule live in one tested place, not inline in the view.

// The subset of the /managers payload this needs. Kept structural so the lib
// doesn't depend on the view's exact types.
export type GustoManager = {
  managerEmail: string | null;
  managerName: string;
  matchCount: number;
  total: number;
};
export type GustoCity = { cityIdentifier: string; managers: GustoManager[] };
export type GustoPayload = { weekStart: string; cities: GustoCity[] };

// Alias map keyed by lower(manager_email) — the same key the pay compute
// accumulates on. First/last are written into the CSV VERBATIM (no split).
// `email` is an OPTIONAL override of the Email column. Absent/null/blank all mean the same thing:
// use the manager's MatchDay address, which is the behaviour that predates this field.
export type GustoAlias = { firstName: string; lastName: string; email?: string | null; note?: string | null };
export type GustoAliasMap = Record<string, GustoAlias>;

export type GustoRow = {
  email: string; // the Email column: the alias override when set, else the MatchDay email
  scheduleEmail: string; // the manager's MatchDay email, kept so the UI can show what was replaced
  origName: string; // managerName as shown on the page
  firstName: string; // First Name column, verbatim from alias when aliased
  lastName: string; // Last Name column
  amount: string; // total.toFixed(2)
  memo: string;
  aliased: boolean; // a NAME alias applied — unchanged meaning, not widened to cover the email
};

// RFC-4180 cell quoting — identical to the view's previous csvCell so the
// no-alias output stays byte-for-byte compatible.
export function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Build the export rows. Iteration order + the total===0 skip match the
// previous inline builder exactly, so with an empty aliasMap the emitted CSV
// is unchanged. When an alias exists (by lower(email)), First/Last come from
// the two stored fields verbatim — NOT from re-splitting managerName.
export function buildGustoRows(
  payload: GustoPayload,
  cityFilter: string, // "ALL" or a cityIdentifier
  aliasMap: GustoAliasMap = {},
): GustoRow[] {
  const rows: GustoRow[] = [];
  for (const city of payload.cities) {
    if (cityFilter !== "ALL" && city.cityIdentifier !== cityFilter) continue;
    for (const m of city.managers) {
      if (m.total === 0) continue;
      const email = m.managerEmail ?? "";
      const key = email.toLowerCase();
      const alias = key ? aliasMap[key] : undefined;
      // THE EMAIL OVERRIDE IS INDEPENDENT OF THE NAME OVERRIDE. An alias row may set the name and
      // leave the email blank, or the reverse. A blank/whitespace override is NOT an override —
      // falling through to the schedule email is what "leave blank" has to mean, or clearing the
      // box would write an empty Email column into a file that pays people.
      const aliasEmail = (alias?.email ?? "").trim();
      const csvEmail = aliasEmail !== "" ? aliasEmail : email;
      let firstName: string;
      let lastName: string;
      if (alias) {
        firstName = alias.firstName;
        lastName = alias.lastName;
      } else {
        const [first, ...rest] = m.managerName.split(" ");
        firstName = first ?? "";
        lastName = rest.join(" ");
      }
      const memo = `${m.matchCount} match${m.matchCount === 1 ? "" : "es"} · ${city.cityIdentifier} · week of ${payload.weekStart}`;
      rows.push({
        email: csvEmail,
        scheduleEmail: email,
        origName: m.managerName,
        firstName,
        lastName,
        amount: m.total.toFixed(2),
        memo,
        aliased: !!alias,
      });
    }
  }
  return rows;
}

// Serialize rows to the exact Gusto contractor CSV: header + CRLF lines +
// trailing CRLF. Column set is fixed and case-sensitive per Gusto's importer.
export function gustoCsvFromRows(rows: GustoRow[]): string {
  const header = ["First Name", "Last Name", "Email", "Fixed amount", "Memo"];
  const lines: string[] = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.firstName),
        csvCell(r.lastName),
        csvCell(r.email),
        csvCell(r.amount),
        csvCell(r.memo),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// The name a row would carry, normalized for collision detection: trimmed,
// case-insensitive, whitespace-collapsed. A case- or space-only difference is
// still the same Gusto worker, so it's still a conflict.
function nameKey(r: GustoRow): string {
  return `${r.firstName} ${r.lastName}`.replace(/\s+/g, " ").trim().toLowerCase();
}

export type GustoConflict = { name: string; rows: GustoRow[] };

// Any two rows that would carry the same First+Last (after aliasing). Payroll
// imports with a duplicate name pay one person twice and another not at all —
// this is the check that blocks the download.
export function findGustoNameConflicts(rows: GustoRow[]): GustoConflict[] {
  const byKey = new Map<string, GustoRow[]>();
  for (const r of rows) {
    const k = nameKey(r);
    const arr = byKey.get(k);
    if (arr) arr.push(r);
    else byKey.set(k, [r]);
  }
  const conflicts: GustoConflict[] = [];
  for (const group of byKey.values()) {
    if (group.length > 1) {
      conflicts.push({
        name: `${group[0].firstName} ${group[0].lastName}`.trim(),
        rows: group,
      });
    }
  }
  return conflicts;
}

export type GustoSummary = {
  total: number;
  aliasedCount: number;
  substitutions: Array<{ email: string; from: string; to: string }>;
};

// Pre-download summary: how many managers, how many aliased, and the full
// from → to list, so the mapping is readable BEFORE the file exists.
export function gustoAliasSummary(rows: GustoRow[]): GustoSummary {
  const aliased = rows.filter((r) => r.aliased);
  return {
    total: rows.length,
    aliasedCount: aliased.length,
    substitutions: aliased.map((r) => ({
      email: r.email,
      from: r.origName,
      to: `${r.firstName} ${r.lastName}`.trim(),
    })),
  };
}
