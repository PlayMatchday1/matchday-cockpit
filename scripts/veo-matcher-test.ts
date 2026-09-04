/* THE VEO MATCHER, UNDER `npm run verify`.
 *
 * src/lib/veo.test.ts is a node:test file and has been for as long as it has existed — which
 * meant it ran nowhere. `npm test` cannot load it (src/lib/adminAuth.ts imports "./cityConfinement"
 * without an extension, which Node's type-stripping ESM loader will not resolve), and
 * scripts/run-suites.mjs never listed it. 56 assertions guarding the one thing in this codebase
 * that writes into a chat players read, run by nothing.
 *
 * This is the shim that puts it in the gate. It runs the file under tsx --test and re-prints the
 * result in the "N passed, M failed" shape run-suites.mjs looks for. It asserts nothing itself, so
 * a zero here means the suite did not run — which the runner already treats as a failure.
 */
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["--yes", "tsx", "--test", "src/lib/veo.test.ts"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const num = (label: string) => {
  const m = new RegExp(`^\\u2139 ${label} (\\d+)$`, "m").exec(out);
  return m ? Number(m[1]) : null;
};
const pass = num("pass");
const fail = num("fail");

if (pass === null || fail === null) {
  console.log(out);
  console.log("Assertions: 0 passed, 1 failed — could not read a node:test summary out of the run");
  process.exit(1);
}
if (fail > 0) console.log(out);
console.log(`Assertions: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
