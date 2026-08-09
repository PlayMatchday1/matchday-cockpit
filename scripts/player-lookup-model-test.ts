import "server-only"; // no-op under --conditions=react-server
// Phase 18 — Player Lookup model, asserted OFFLINE. Detection drives the hint and the
// server query; the spot suggestion is the "add to a match" default. Plain assertions
// + MUTATION tests (each mutation must PASS for the real impl and FAIL for a broken
// one, or the assertion proves nothing).
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/player-lookup-model-test.ts
import {
  detectKind, serverQuery, openSpots, matchOpen, suggestSpot, money, type SpotTeam,
} from "../src/lib/playerLookupModel";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const eq = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
function mutation<T>(name: string, real: T, broken: T, assertion: (impl: T) => boolean) {
  let r = false, b = true;
  try { r = assertion(real); } catch { r = false; }
  try { b = assertion(broken); } catch { b = false; }
  (r && !b) ? ok(`${name}: real PASSES, broken FAILS (teeth)`) : bad(name, `real=${r} broken=${b}`);
}

// ---- detection ----
eq("empty -> empty", detectKind("   ").kind, "empty");
eq("email by @", detectKind("Foo@Bar.com").kind, "email");
eq("email normalises to lower", detectKind("Foo@Bar.com").norm, "foo@bar.com");
eq("bare 5 digits -> id (not phone)", detectKind("85527").kind, "id");
eq("bare 6 digits -> id", detectKind("123456").kind, "id");
eq("7 digits -> phone", detectKind("1234567").kind, "phone");
eq("formatted phone -> phone, digits only", detectKind("+1 (832) 901-5669").kind, "phone");
eq("phone norm strips formatting", detectKind("+1 (832) 901-5669").norm, "18329015669");
eq("words -> name", detectKind("Marisol Reyes").kind, "name");
eq("name norm lowercased", detectKind("Marisol Reyes").norm, "marisol reyes");
// a name containing a short digit run is still a name (has non-digits, not <=6 all-digits)
eq("mixed token -> name", detectKind("Field 6").kind, "name");

// ---- server query: pure id is EXACT ?id; everything else is fuzzy ?email ----
eq("id -> ?id", serverQuery(detectKind("85527")), { id: "85527" });
eq("phone -> ?email digits", serverQuery(detectKind("+1 832 901 5669")), { email: "18329015669" });
eq("email -> ?email", serverQuery(detectKind("a@b.com")), { email: "a@b.com" });
eq("name -> ?email", serverQuery(detectKind("Abdel")), { email: "abdel" });

// The whole point of the 1-6-digit rule: a player ID must not be searched as a phone.
mutation("id-not-phone", detectKind, ((raw: string) => { // broken: treat all digits as phone
  const q = raw.trim(); const digits = q.replace(/[^\d]/g, "");
  if (q.includes("@")) return { kind: "email", norm: q } as const;
  if (digits.length >= 4) return { kind: "phone", norm: digits } as const;
  return { kind: "name", norm: q } as const;
}) as typeof detectKind, (fn) => fn("85527").kind === "id");

// ---- open spots ----
eq("openSpots skips taken, 1-based", openSpots({ size: 5, taken: [1, 3] }), [2, 4, 5]);
eq("openSpots full -> []", openSpots({ size: 3, taken: [1, 2, 3] }), []);
eq("matchOpen sums teams", matchOpen([{ size: 4, taken: [1, 2] }, { size: 4, taken: [] }]), 6);

// ---- suggestion: emptier team, then lowest free number ----
const balance: SpotTeam[] = [{ size: 9, taken: [1, 2, 3, 4] }, { size: 9, taken: [2, 3] }];
eq("suggest picks EMPTIER team (index 1)", suggestSpot(balance)?.team, 1);
eq("suggest lowest free number on that team (1)", suggestSpot(balance)?.spot, 1);
const oneFull: SpotTeam[] = [{ size: 3, taken: [1, 2, 3] }, { size: 5, taken: [1] }];
eq("suggest skips a full team", suggestSpot(oneFull), { team: 1, spot: 2 });
eq("suggest null when all full", suggestSpot([{ size: 2, taken: [1, 2] }]), null);
eq("tie on emptiness -> lower team index", suggestSpot([{ size: 5, taken: [1] }, { size: 5, taken: [2] }]), { team: 0, spot: 2 });

// suggestion must BALANCE before it fills — a broken impl that just fills the first
// gap would pick team 0 spot 5 for `balance`; the real one picks the emptier side.
mutation("suggest-balances", suggestSpot, ((teams: SpotTeam[]) => { // broken: first team with a gap, lowest number
  for (let i = 0; i < teams.length; i++) { const f = openSpots(teams[i]); if (f.length) return { team: i, spot: f[0] }; }
  return null;
}) as typeof suggestSpot, (fn) => { const s = fn(balance); return !!s && s.team === 1; });

// ---- money ----
eq("money cents->dollars", money(1200), "$12.00");
eq("money null -> $0.00", money(null), "$0.00");
eq("money 861", money(861), "$8.61");

console.log(`\nplayer-lookup-model: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
