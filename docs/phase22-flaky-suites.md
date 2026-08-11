# Phase 22 evidence — e2e suites that flake on a shared auth artifact

Collecting evidence, NOT fixing yet. Several browser suites fail intermittently with **no code
change between a failing and a passing run** — a flake, not a regression. The common thread is
the **shared session artifact `.auth/state.json`** (and Supabase magic-link rate-limiting at the
tail of a full run). When we fix the shared auth artifact in Phase 22, re-check whether these stop.

## The hypothesis (the "shared auth artifact")

`.auth/state.json` holds a real Supabase session whose **refresh token is single-use** — Supabase
rotates it on every refresh, but the rotated token is never written back to the file. So any suite
that loads `.auth/state.json` authenticates via that refresh token, and the **next** suite/run that
reads the same (now-consumed) token can't refresh → the page never authenticates → a
`waitForSelector` on post-auth content times out (exit 2). Fresh-mint suites (e.g.
verify-snapshot, verify-crm-characterize) don't touch the file and don't flake this way.
Additionally, Supabase **rate-limits magic-link generation** at the tail of a full gated run, which
hits the fresh-mint suites that come last.

Confirmed once already this session: `verify-fields` (reads `.auth/state.json`) timed out on
`.se-sc.nodoc` after my own `page.clock` experiments consumed the file's refresh token; regenerating
with `node scripts/e2e/auth.mjs --force` fixed it immediately, no code change.

## Log

| Date (approx) | Suite | Symptom | Reads .auth/state.json? |
|---|---|---|---|
| 2026-08-11 | verify-changelog.mjs | **exit 2 on one push, PASSED on the very next push, no code change between** (observed during Phase 19 Step 2 pushes) | yes |
| (this session) | verify-fields.mjs | timed out on `.se-sc.nodoc`; fixed by `auth.mjs --force` (consumed refresh token) | yes |
| (quarantined) | verify-year.mjs | non-hermetic: LIVE manager-pay data + magic-link rate-limit at run tail | mints fresh |
| (quarantined) | verify-week.mjs | time-dependent fixture (separate root cause — now-relative meeting times); see run-suites QUARANTINE | reads it |

## The fix to try in Phase 22

Make the shared session robust: either (a) write the rotated refresh token back to
`.auth/state.json` after each use, (b) regenerate the file per-suite (small cost, no cross-suite
token contention), or (c) switch the `.auth/state.json` readers (verify-fields, verify-changelog,
verify-week, verify-reviews) to the **fresh-mint** pattern verify-snapshot/verify-crm-characterize
use — one minted session per suite, no shared file. Then re-run the full gate several times and
confirm the intermittent exit-2 failures stop. `verify-week`'s time-dependent fixture is a separate
fix (freeze its meeting times) and won't be resolved by the auth change.
