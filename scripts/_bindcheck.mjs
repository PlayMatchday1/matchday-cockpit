/* A BIND CHECK FOR THE BROWSER SCRIPTS, because `node --check` is only a PARSE check.
 *
 * WHY THIS EXISTS. Removing a block from _check_promo_day.mjs took seven bindings with it -
 * createClient, TAG_KEYS, TAG_META, SHARE_FIELDS, isRevenueShareVenue, TAG_ROWS and TAGCTX - all
 * because they had been declared as dynamic imports INSIDE whichever block first needed them.
 * `node --check` passed, because an undefined identifier is not a syntax error, and a twelve-minute
 * run died on a ReferenceError at assertion 84 with exit 2: a run that never got to decide.
 *
 * tsc --allowJs --checkJs BINDS every identifier and reports the lot in about four seconds. That is
 * the difference between a parse check and a bind check, and it is the generalisation of the
 * exit-code rule: do not accept a gate that cannot fail the way your bug fails.
 *
 *   node scripts/_bindcheck.mjs            # every browser script
 *   node scripts/_bindcheck.mjs <path>     # just one
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const only = process.argv[2];
const files = only ? [only]
  : readdirSync('scripts').filter(f => f.endsWith('.mjs') && f.startsWith('_check')).map(f => `scripts/${f}`);

let bad = 0;
for (const f of files) {
  let out = '';
  try {
    execFileSync('npx', ['tsc', '--noEmit', '--allowJs', '--checkJs', '--target', 'es2022',
      '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', f],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  /* ONLY UNBOUND NAMES. checkJs on an un-annotated script reports a great deal that is not a bug -
   * implicit any, loose property access - and a gate that cries about those is a gate people stop
   * running. TS2304 is "Cannot find name", which is exactly the failure this exists for. */
  const unbound = out.split('\n').filter(l => /error TS2304: Cannot find name/.test(l));
  if (unbound.length) {
    bad += unbound.length;
    console.log(`FAIL ${f}: ${unbound.length} unbound identifier(s)`);
    for (const l of unbound) console.log(`  ${l.trim()}`);
  } else {
    console.log(`ok   ${f}: every identifier binds`);
  }
}
console.log(bad === 0 ? '\nall bound' : `\n${bad} unbound identifier(s)`);
process.exit(bad ? 1 : 0);
