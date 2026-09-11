/* THE GUARD ON "[object Object]".
 *
 * A PostgrestError is a plain object, so `String(e)` renders "[object Object]" and the real message
 * — the one naming the column or the refusal — is lost at the last step. That reached a person:
 * Deonna Garcia pressed Save field on Field Ops and read "[object Object]".
 *
 * This suite pins two things: the helper turns every shape a catch can receive into something a
 * reader can act on, and the three catches in CitiesFieldsLens (the drawer she used) go through it
 * rather than through String(). The second half is a source assertion on purpose — the failure was
 * one call site's last expression, and no unit test of the helper would have caught it. */
import { readFileSync } from "node:fs";
import { errorText } from "@/lib/errorText";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("\n— a Supabase error is an object, and it must not render as one —");
/* THE EXACT OBJECT PRODUCTION RETURNED, reproduced with her account on 2026-09-11 against
 * fin_venues. Kept verbatim: this is the failure the helper exists for. */
const HERS = { code: "23502", details: null, hint: null, message: 'null value in column "billing_type" of relation "fin_venues" violates not-null constraint' };
yes("CONTROL: String() on it really does render [object Object]", String(HERS) === "[object Object]");
yes("CONTROL: …and it is not an Error", !(HERS instanceof Error));
yes("the helper shows the database's own message", errorText(HERS).includes('null value in column "billing_type"'), errorText(HERS));
yes("…and never [object Object]", !/\[object Object\]/.test(errorText(HERS)), errorText(HERS));
yes("…and carries the code, so a reader can tell a refusal from a fault", errorText(HERS).includes("23502"), errorText(HERS));

console.log("\n— a refusal reads as a refusal, not as a Postgres code —");
const DENIED = { code: "42501", details: null, hint: null, message: "new row violates row-level security policy for table \"fin_venues\"" };
is("42501 is said in plain words", errorText(DENIED), "Your account is not allowed to do this. Ask an admin.");
yes("…with no code in it", !/42501/.test(errorText(DENIED)));
is("an expired session says to reload", errorText({ code: "PGRST301", message: "JWT expired" }), "Your session has expired. Reload the page and sign in again.");

console.log("\n— every other shape a catch can receive —");
is("a real Error keeps its message", errorText(new Error("Failed to fetch")), "Failed to fetch");
is("a string is itself", errorText("Min Players must be a whole number."), "Min Players must be a whole number.");
is("null falls back", errorText(null), "Something went wrong.");
is("…and the caller can choose the fallback", errorText(undefined, "Failed to load fields."), "Failed to load fields.");
is("an object with no message prints its shape, not [object Object]", errorText({ status: 500, body: null }), "Something went wrong. (status, body)");
is("…and a code alone is still shown", errorText({ code: "08006" }), "Something went wrong. (08006)");
yes("a message with no code is printed bare", errorText({ message: "duplicate key" }) === "duplicate key");

console.log("\n— the call sites that hit the database use it —");
/* SCOPED TO THE FILE THE INCIDENT HAPPENED IN. The other 38 sites that can receive a Supabase
 * error are listed in the report for a deliberate pass; pinning them here would assert work that
 * has not been done. */
const LENS = readFileSync("src/components/CitiesFieldsLens.tsx", "utf8");
const noComments = (x: string) => x.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const SRC = noComments(LENS);
yes("CitiesFieldsLens imports the helper", /import \{ errorText \} from "@\/lib\/errorText"/.test(SRC));
is("…and no catch in it falls back to String()", SRC.match(/instanceof Error \? [^:]*\.message : String\(/g), null);
/* THE THREE CATCHES, each named: save (the one she pressed), doDelete, and load — which used to
 * replace the real message with "Failed to load fields." so a refusal and a network failure read
 * the same. */
yes("save shows the real error", /setModalError\(errorText\(e\)\)/.test(SRC));
yes("doDelete shows the real error", /setError\(errorText\(e\)\)/.test(SRC));
yes("load keeps its fallback but only as a fallback", /setError\(errorText\(e, "Failed to load fields\."\)\)/.test(SRC));
/* AND THE VALIDATION PATH IS UNTOUCHED — it was already correct, and the helper must not have been
 * dragged across it. */
yes("CONTROL: buildFieldPayload's own message still goes straight to the drawer", /setModalError\(result\.error\)/.test(SRC));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
