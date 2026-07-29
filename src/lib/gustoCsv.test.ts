import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGustoRows,
  gustoCsvFromRows,
  findGustoNameConflicts,
  gustoAliasSummary,
  type GustoPayload,
} from "./gustoCsv.ts";

const payload: GustoPayload = {
  weekStart: "2026-07-20",
  cities: [
    {
      cityIdentifier: "ATL",
      managers: [
        { managerEmail: "troy@yahoo.com", managerName: "Troy", matchCount: 5, total: 150 },
        { managerEmail: "ZERO@x.com", managerName: "Zero Pay", matchCount: 0, total: 0 },
      ],
    },
    {
      cityIdentifier: "ATX",
      managers: [
        { managerEmail: "jane@x.com", managerName: "Jane Doe", matchCount: 2, total: 60 },
      ],
    },
  ],
};

// The exact byte output the previous inline builder produced for this payload
// with no aliases — the contract #2 protects.
const EXPECTED_NO_ALIAS =
  "First Name,Last Name,Email,Fixed amount,Memo\r\n" +
  "Troy,,troy@yahoo.com,150.00,5 matches · ATL · week of 2026-07-20\r\n" +
  "Jane,Doe,jane@x.com,60.00,2 matches · ATX · week of 2026-07-20\r\n";

test("no aliases → byte-identical to the legacy output (Troy keeps empty Last)", () => {
  const rows = buildGustoRows(payload, "ALL", {});
  assert.equal(gustoCsvFromRows(rows), EXPECTED_NO_ALIAS);
});

test("zero-total managers are excluded", () => {
  const rows = buildGustoRows(payload, "ALL", {});
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => r.email === "ZERO@x.com"));
});

test("alias writes First/Last VERBATIM — no re-split — and fixes the empty Last", () => {
  const rows = buildGustoRows(payload, "ALL", {
    "troy@yahoo.com": { firstName: "Troy", lastName: "Moodie" },
  });
  const troy = rows.find((r) => r.email === "troy@yahoo.com")!;
  assert.equal(troy.firstName, "Troy");
  assert.equal(troy.lastName, "Moodie");
  assert.equal(troy.aliased, true);
  // Only that one row changed; Jane is untouched, and email/amount/memo intact.
  const csv = gustoCsvFromRows(rows);
  assert.match(csv, /Troy,Moodie,troy@yahoo\.com,150\.00,/);
  assert.match(csv, /Jane,Doe,jane@x\.com,60\.00,/);
});

test("alias with spaces in a part is written verbatim, never re-split", () => {
  const rows = buildGustoRows(payload, "ALL", {
    "jane@x.com": { firstName: "Mary Jane", lastName: "Van Der Berg" },
  });
  const jane = rows.find((r) => r.email === "jane@x.com")!;
  assert.equal(jane.firstName, "Mary Jane");
  assert.equal(jane.lastName, "Van Der Berg");
});

test("alias lookup keys on lower(email)", () => {
  // Payload email is 'jane@x.com'; alias stored under the (already-lower) key.
  const rows = buildGustoRows(
    { ...payload, cities: [{ cityIdentifier: "ATX", managers: [{ managerEmail: "Jane@X.com", managerName: "Jane Doe", matchCount: 2, total: 60 }] }] },
    "ALL",
    { "jane@x.com": { firstName: "Jane", lastName: "Alias" } },
  );
  assert.equal(rows[0].lastName, "Alias", "mixed-case payload email still matches the lowercased alias key");
});

test("city filter restricts rows", () => {
  const rows = buildGustoRows(payload, "ATX", {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "jane@x.com");
});

test("duplicate First+Last after aliasing is detected (case/space-insensitive)", () => {
  // Alias Jane onto "Troy Moodie" while Troy is also aliased to Troy Moodie.
  const rows = buildGustoRows(payload, "ALL", {
    "troy@yahoo.com": { firstName: "Troy", lastName: "Moodie" },
    "jane@x.com": { firstName: "troy", lastName: " moodie " },
  });
  const conflicts = findGustoNameConflicts(rows);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].rows.length, 2);
  assert.deepEqual(
    conflicts[0].rows.map((r) => r.email).sort(),
    ["jane@x.com", "troy@yahoo.com"],
  );
});

test("no duplicates → no conflicts", () => {
  const rows = buildGustoRows(payload, "ALL", {
    "troy@yahoo.com": { firstName: "Troy", lastName: "Moodie" },
  });
  assert.equal(findGustoNameConflicts(rows).length, 0);
});

test("summary reports total, aliased count, and the from→to list", () => {
  const rows = buildGustoRows(payload, "ALL", {
    "troy@yahoo.com": { firstName: "Troy", lastName: "Moodie" },
  });
  const s = gustoAliasSummary(rows);
  assert.equal(s.total, 2);
  assert.equal(s.aliasedCount, 1);
  assert.deepEqual(s.substitutions, [
    { email: "troy@yahoo.com", from: "Troy", to: "Troy Moodie" },
  ]);
});
