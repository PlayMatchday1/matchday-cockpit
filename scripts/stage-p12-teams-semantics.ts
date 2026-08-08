import "server-only"; // no-op under --conditions=react-server
// PHASE 12 PART B - does PUT /admin/teams/{id} PATCH or REPLACE? Proven on STAGING,
// one field per write, no retry, restore after each. If a single-field write moves
// anything but that field + updatedAt, the endpoint REPLACES — STOP, do not touch
// production. NEVER send password.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/stage-p12-teams-semantics.ts
import { apiGet, apiWrite } from "../src/lib/matchdayStageApi";
try { process.loadEnvFile(".env.local"); } catch {}

const MATCH = 2470;
const line = (s = "") => console.log(s);
const hr = () => line("-".repeat(72));
// team fields the GET returns; updatedAt is server-derived. WRITABLE (Retool):
// name, locked, price, password (password is write-only, never read/sent here).
const DERIVED = new Set(["updatedAt"]);
const WRITABLE_READABLE = ["name", "locked", "price"]; // for reconcile-restore

async function getTeam(teamId: number): Promise<Record<string, unknown>> {
  const m = await apiGet<Record<string, unknown>>("staging", `/admin/matches/${MATCH}`);
  const teams = (m.teams as Record<string, unknown>[]) ?? [];
  const t = teams.find((x) => x.id === teamId);
  if (!t) throw new Error(`team ${teamId} not found on match ${MATCH}`);
  return t;
}
const moved = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !DERIVED.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));

let replaced = false;

async function testField(teamId: number, field: string, newVal: unknown): Promise<boolean> {
  hr(); line(`WRITE { ${field}: ${JSON.stringify(newVal)} } to /admin/teams/${teamId}`); hr();
  const BEFORE = await getTeam(teamId);
  line(`before: name=${JSON.stringify(BEFORE.name)} locked=${JSON.stringify(BEFORE.locked)} price=${JSON.stringify(BEFORE.price)}`);
  await apiWrite("staging", "PUT", `/admin/teams/${teamId}`, { [field]: newVal });
  const AFTER = await getTeam(teamId);
  const changed = moved(BEFORE, AFTER);
  const derivedMoved = ["updatedAt"].filter((k) => JSON.stringify(BEFORE[k]) !== JSON.stringify(AFTER[k]));
  const unexpected = changed.filter((k) => k !== field);
  line(`fields that moved (excl updatedAt): ${changed.join(", ") || "(none)"}   updatedAt moved: ${derivedMoved.length ? "yes" : "no"}`);
  for (const k of changed) line(`   ${k}: ${JSON.stringify(BEFORE[k])} -> ${JSON.stringify(AFTER[k])}`);

  if (unexpected.length) {
    line(`\n*** REPLACE DETECTED: writing { ${field} } also moved: ${unexpected.join(", ")} ***`);
    const nulled = unexpected.filter((k) => AFTER[k] === null || AFTER[k] === "" || AFTER[k] === 0);
    if (nulled.length) line(`   fields nulled/emptied: ${nulled.join(", ")}`);
    line(`   (password is write-only and cannot be read back — a replace would null it unrecoverably.)`);
    // reconcile-restore the readable writable fields so staging is left clean
    const restore: Record<string, unknown> = {};
    for (const k of WRITABLE_READABLE) if (JSON.stringify(BEFORE[k]) !== JSON.stringify(AFTER[k])) restore[k] = BEFORE[k];
    if (Object.keys(restore).length) { await apiWrite("staging", "PUT", `/admin/teams/${teamId}`, restore); line(`   reconciled: restored ${Object.keys(restore).join(", ")}`); }
    replaced = true;
    return false;
  }

  // PATCH: restore the one field
  await apiWrite("staging", "PUT", `/admin/teams/${teamId}`, { [field]: BEFORE[field] });
  const FINAL = await getTeam(teamId);
  const stillOff = moved(BEFORE, FINAL);
  line(`restored: ${stillOff.length === 0 ? "yes — all fields back to BEFORE (except updatedAt)" : "NO — still off: " + stillOff.join(", ")}`);
  line(`=> { ${field} } alone moved only ${field}${derivedMoved.length ? " + updatedAt" : ""}: PATCHES.`);
  return true;
}

async function main() {
  const m = await apiGet<Record<string, unknown>>("staging", `/admin/matches/${MATCH}`);
  const teams = (m.teams as Record<string, unknown>[]) ?? [];
  if (!teams.length) { line("no teams on the staging match"); process.exit(5); }
  const TID = teams[0].id as number;
  line(`staging match ${MATCH}, team ${TID} ("${teams[0].name}")\n`);

  const t0 = await getTeam(TID);
  if (!(await testField(TID, "price", (Number(t0.price) || 0) + 100))) return;
  if (!(await testField(TID, "name", `${String(t0.name)} [p12]`))) return;
  if (!(await testField(TID, "locked", true))) return;

  line(); hr();
  line(replaced ? "VERDICT: REPLACES — STOP. Do not touch production; name-only team writes are unsafe."
    : "VERDICT: PUT /admin/teams/{id} PATCHES — a single-field write moves only that field + updatedAt. The roster mockup's changed-fields-only team writes are safe.");
}
main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message.replace(/Body:.*/s, "Body:[omitted]") : e); process.exit(1); });
