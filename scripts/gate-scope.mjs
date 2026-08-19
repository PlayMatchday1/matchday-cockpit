// WHICH GATE DOES THIS PUSH NEED — decided from the diff, in one reviewable place.
//
// THE POLICY: the gate exists for WRITES TO THE MATCHDAY API. Those reach players — a wrong match
// name, a wrong price, a duplicated charge. Everything else gets typecheck. The pre-push hook never
// learned that, so a CSS change and a match-edit change both cost nine minutes.
//
// THE ALLOWLIST IS THE *TYPECHECK* SIDE, DELIBERATELY, AND THAT IS THE WHOLE SAFETY ARGUMENT.
// Listing what is SAFE means anything unrecognised — a new directory, a file nobody classified, a
// path added next month — falls to the FULL gate by default. Listing what is dangerous instead
// would mean the unrecognised case silently skips, and the failure would be a player-visible write
// that nobody tested. A false full gate costs nine minutes. A false skip costs a player.
//
// WHY src/ IS NOT ON THE SAFE LIST, not even components. A component is not "just UI" here: the
// 🎥 name write is composed in VeoMasterSchedule, the credit adjustment amount is computed in
// PlayerLookup, and the promo write body is built in PromoCodes. A component can send the wrong
// body to a correctly-gated route. So every path under src/ takes the full gate.
//
// The kept carve-outs (verify-user-permissions, verify-user-delete, matchops-auth-test and the
// sub-second guards) live under scripts/, which is also full-gate: a permission regression is
// invisible on screen, which is exactly why those suites survived the testing cut.

/**
 * Paths whose changes CANNOT reach a MatchDay write. Anything not matching goes to the full gate.
 * Matched as prefixes, plus a few extension rules.
 */
export const TYPECHECK_ONLY = [
  "docs/",           // the API facts record and everything beside it
  "mockups/",        // HTML mockups — never imported by the app
  "public/",         // static assets
  ".vscode/",
  ".github/",        // CI config; the hook itself is NOT here (see FULL_GATE_ALWAYS)
];

/** Extensions that are presentation or prose wherever they live, including under src/. */
export const TYPECHECK_ONLY_EXT = [".css", ".md", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"];

/**
 * Paths that ALWAYS force the full gate even if something above would have matched — the gate's own
 * machinery. A change here changes what "passing" means, so it is never taken on trust.
 */
export const FULL_GATE_ALWAYS = [
  ".githooks/",
  "scripts/run-suites.mjs",
  "scripts/gate-scope.mjs",
  "scripts/quarantine.pinned.json",
  "package.json",
  "package-lock.json",
];

const isTypecheckOnly = (p) => {
  if (FULL_GATE_ALWAYS.some((f) => p === f || p.startsWith(f))) return false;
  if (TYPECHECK_ONLY_EXT.some((e) => p.toLowerCase().endsWith(e))) return true;
  return TYPECHECK_ONLY.some((d) => p.startsWith(d));
};

/**
 * @param {string[]} changed paths, repo-relative, as `git diff --name-only` prints them
 * @returns {{ mode: "full"|"typecheck", reason: string, deciding: string[] }}
 */
export function decideGateScope(changed) {
  const paths = (changed ?? []).map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) {
    // No diff to reason about — could be a tag, a merge, or a hook invoked oddly. Take the gate.
    return { mode: "full", reason: "no changed paths could be read from the diff", deciding: [] };
  }
  const deciding = paths.filter((p) => !isTypecheckOnly(p));
  if (deciding.length === 0) {
    return {
      mode: "typecheck",
      reason: `all ${paths.length} changed path(s) are presentation or prose — none can reach a MatchDay write`,
      deciding: [],
    };
  }
  return {
    mode: "full",
    reason: `${deciding.length} changed path(s) could reach a MatchDay write, an auth gate, a migration or the gate itself`,
    deciding: deciding.slice(0, 8),
  };
}

// CLI: `node scripts/gate-scope.mjs <path> <path> …` → prints the decision and exits 0 (typecheck)
// or 10 (full), so the shell hook can branch on the status without parsing text.
if (process.argv[1] && process.argv[1].endsWith("gate-scope.mjs")) {
  const d = decideGateScope(process.argv.slice(2));
  console.log(`▶ gate scope: ${d.mode.toUpperCase()} — ${d.reason}`);
  if (d.deciding.length) {
    console.log("  because of:");
    for (const p of d.deciding) console.log(`    · ${p}`);
    const extra = process.argv.slice(2).filter((p) => !isTypecheckOnly(p)).length - d.deciding.length;
    if (extra > 0) console.log(`    · …and ${extra} more`);
  }
  process.exit(d.mode === "full" ? 10 : 0);
}
