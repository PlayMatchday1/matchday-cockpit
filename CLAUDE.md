# Clubhouse — standing rules

Read `docs/matchday-api-facts.md` before touching anything that talks to the
MatchDay API, Supabase, Stripe, or the CRM. It is the record of what has been
proven, and it is kept current. Add to it when you learn something new.

## How to work

**Answers first.** When a task depends on how the API or the data actually
behaves, find out and report before writing code. If something is not in
evidence, say UNKNOWN. Do not guess and do not build on a guess.

**Staging data is not evidence.** Neither is Retool's UI. A field missing from a
Retool table mapping does not mean the API omits it — read the payload.

**Say what you did not do.** Scope cuts, disabled controls and unbuilt paths go
in the report, not just in the code.

## Evidence

Every entry in `docs/matchday-api-facts.md` carries its evidence: the endpoint and the
payload it came from, or a `file:line`. **An entry with no evidence is UNKNOWN, however
confidently it is worded.** This is not a style rule — a line reading `Update is PATCH
/admin/promocodes/{id}` with no probe behind it was treated as settled and nearly became an
edit form aimed at 100%-off codes.

## Writes

- **The diff IS the request body.** `PUT` has PATCH semantics — send only what
  changed. Clearing a box is not a change.
- **A 2xx does not mean the write landed.** Report LANDED / FAILED /
  NOT APPLIED / UNKNOWN.
- **Writes never retry.** There is no `Idempotency-Key`. A duplicate message or
  a duplicate charge is visible to a player.
- Every non-GET is **host-guarded on the parsed host**, never on a config
  string. `…herokuapp.com.evil.com` must be rejected.
- Every write goes through `recordWrite()` into `change_log`. Never log a
  message body — that is a second copy of player PII with different access
  rules.

## Traps that have already cost us

- **Match `startDate`/`endDate` are LOCAL WALL CLOCK despite the `Z` suffix.**
  `new Date(str)` re-shifts them and lands hours off.
- **Promo `startDateUtc`/`endDateUtc` are TRUE UTC.** The opposite model. Never
  share helpers between the two; each file says which model it implements.
- Display promo times in **`America/Chicago`** (IANA, DST-aware). Retool
  hardcodes `-06:00` and is an hour wrong from March to November.
- **Prices are cents.** `autoCanceledMinutes` is MINUTES; the spec says hours
  and the spec is wrong.
- **`maxTeamSize2Team` / `maxTeamSize4Team` are TOTALS**, not per side. A "10 ×
  10" control sends 20.
- **`_count.players` is authoritative — and excludes MORE than cancelled rows.**
  Proven on prod 17516: 38 user-match rows, `_count.players` **18** = 15 `PAID` + 3 `FREE`;
  excluded are **18 `paidStatus:"WAITING"`** + 2 `isCancelled`. WAITING = a checkout that never
  settled; a retried one leaves a row per attempt (one player made 27). Filtering only cancelled
  leaves 36 of 38 — the bug this rule used to cause. Use **`rosterRowCounts()`**
  (`src/lib/gamedayModel.ts`); never re-derive it.
- **Player names live under `p.user`**, not on `p` directly.
- `GET /api/v1/admin/promocodes` has **no ORDER BY**. Paging is only sound while
  nothing writes; a row updated between two page fetches can appear twice or be
  skipped.
- `password` on teams is **write-only and deny-listed**. Never render it, never
  send it.

## Permissions

New rights follow the Phase 17 pattern: a migration adding the column off by
default, read **fresh from the database on every request** with no JWT caching,
granted to Ryan only, the E2E service account blocked at the database **keyed on
email, not `full_name`**, greyed buttons as courtesy only, and revoke SQL **with
a `WHERE` clause** — `pg_safeupdate` rejects an unqualified UPDATE.

`adminAuth` reads `app_users` with `select("*")` deliberately. **Never name
permission columns there** — code deploys before migrations apply, and a named
column that does not exist yet 500s every admin route.

Migrations land before the code that depends on them.

## The bar

**Set 2026-08-25, replacing "the gate". There is no browser lane. There is no E2E on a push.**

**The default, for everything: typecheck, look at it in a browser, push.** No new assertions, no
new suites. Admin UI, reports, filters, layout, copy, read-only pages — all of it. If the change
renders something, open it and look; that is the check.

**The one exception: checkout, bookings, payments, credits — anything that changes what a player
is CHARGED or what a match record says HAPPENED.** Those get a fast targeted check. Minutes, not
twenty. Run the node guards that cover the path you touched and read the output; that is what they
are for.

**Bucket the change BEFORE you reach for a test, not after.** If you cannot place it confidently,
ask. Do not default to running everything — over-testing is not free, and a twenty-minute run that
teaches nothing has a cost that lands on the next task.

`npm run verify` — typecheck plus the node guards, about twenty seconds — runs on every push and
is the whole pre-push gate. Those suites are not a general test suite: they are the guards on what
reaches a player (the stage deny-list, the production host guard, the wall-clock trap, the
change-log hook, the credits / roster / promo write models). A suite reporting zero assertions is
failing, not passing.

**The browser suites still exist and still run on demand** — `npm run verify:e2e`, or one file
directly — for the rare change where driving the page is genuinely the fastest way to see it. They
are a tool, not a toll. **There is no quarantine list**: nothing is mandatory, so a red browser
suite is a suite you do not run, and bookkeeping about which ones those are is bookkeeping about
nothing.

**WHY THIS CHANGED.** The browser lane blocked six pushes in one day and not one block was the
change. It was a suite that had dated (a day-25 assertion, on the 25th), a suite that timed out
under contention, a suite testing a working tree that was being edited while it ran, and a real
$12 reporting gap that had nothing to do with any diff in front of it. Twenty minutes to learn
nothing is a tax, not a gate.

### If you do write a suite, these still hold

Extending or fixing an existing suite is always fine. A refactor keeps the existing assertion
**bodies unchanged** — a test edited to make it pass records the new behaviour, it does not verify
the old one. Selector-path edits are allowed and must be itemised.

**AN ABSENCE ASSERTION NEEDS A PRESENCE WAIT FIRST.** Checking that something is NOT on the page
proves nothing until you have proven the page rendered. A flat sleep is not a ready signal, and a
loading screen satisfies almost every absence check you can write.

**A COUNTING OR ABSENCE ASSERTION NEEDS A POSITIVE CONTROL** — the same pattern proven to find at
least one match somewhere it definitely exists, in the same run. A regex that matches nothing, a
selector nobody renders, and a page that failed to load all produce the same zero, and zero is the
answer these assertions are usually hoping for. This applies where the passing value is zero or
absence; an assertion expecting exactly N >= 1 is already self-controlling.

**ASSERT ON THE THING, NOT ON A SHAPE.** A selector broad enough to match a different element is
not a positive control — it passes on the wrong subject.

**DERIVE, DO NOT PIN.** `verify-pace-readout` hardcoded days 25 and 31 as "days the month has not
reached" and went red on the 25th. Derive the boundary from the data the page is showing.

**A SUITE MUST NOT WRITE PRODUCTION.** If it needs a different world, build it from fixtures or
mock the response — never by editing the live one and promising to put it back. A `try/finally`
restore does not survive the process being killed, and one did not.

**READ THE EXIT CODE BEFORE DIAGNOSING.** Exit 1 is a suite that decided something is wrong. Exit
2 is a Playwright timeout — a suite that never got to decide. And the shape of a failure names its
cause: one assertion with a specific wrong value is a DATED suite; every assertion failing
including its own controls is a page that never loaded.

## Reading what a tool actually said

**An exit code from a pipeline is the LAST command's.** `npm run verify | tail -5`
reports whether `tail` succeeded. A green "exit code 0" has already been reported
here on a suite that failed. Run the command bare and read `$?`, or capture it
before the pipe. The same applies to `PIPESTATUS` — read it, do not assume `[0]`.

**Do not parse a column out of deploy status. Read the row.** Three times in one
session a `vercel ls | awk '{print $N}'` reported stale or wrong deployment state,
and every time the fix was to stop parsing and read the whole line. Column order
and headers are not a contract. Print the row and quote it, or ask for a named
field (`--json`, `-o json`) — never count spaces. **A tool that reports stale state
is worse than checking by hand**, because checking by hand is known to be manual
and its output is not.

**A push is not landed until `git ls-remote origin refs/heads/main` says so.** A
killed `git push` leaves the local tracking ref untouched and `git log` looking
identical to success.

## Never

- Echo, log, print or commit `MATCHDAY_STAGE_API_PASSWORD`,
  `MATCHDAY_PROD_API_PASSWORD`, `STRIPE_SECRET_KEY`, `CRON_SECRET`, the service
  account JSON or the Apple `.p8` — including inside error messages.
- Leave `vercel env pull` output on disk. It contains every production secret.
- Touch Retool or its configuration. It is the reference implementation.
  "Replace app with JSON/ZIP" must never be clicked.
- Ship a control that looks live but does nothing. Disable it and state why.
