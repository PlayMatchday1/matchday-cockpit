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
- **`_count.players` is authoritative.** `players.length` includes cancelled
  rows.
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

## The gate

`npm run verify` and `npm run verify:e2e` must both pass. A suite reporting zero
assertions is failing, not passing. The quarantine list is pinned in
`scripts/quarantine.pinned.json` and the gate fails on any drift — growing it is
an explicit, reviewable edit in the same commit.

Refactors get a characterization net first, and the existing assertion **bodies
stay unchanged**. A test you edited to make pass records the new behaviour; it
does not verify the old one. Selector-path edits are allowed and must be
itemised.

## Never

- Echo, log, print or commit `MATCHDAY_STAGE_API_PASSWORD`,
  `MATCHDAY_PROD_API_PASSWORD`, `STRIPE_SECRET_KEY`, `CRON_SECRET`, the service
  account JSON or the Apple `.p8` — including inside error messages.
- Leave `vercel env pull` output on disk. It contains every production secret.
- Touch Retool or its configuration. It is the reference implementation.
  "Replace app with JSON/ZIP" must never be clicked.
- Ship a control that looks live but does nothing. Disable it and state why.
