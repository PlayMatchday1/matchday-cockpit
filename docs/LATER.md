# Later

Changes that are decided but not done. Each one ships on its own, by pushing to main, never
`vercel deploy --prod`. Delete an entry when it lands.

## Match Ops › Offers: Specific players holdout

**Decided by Ryan, 2026-11-02. Clubhouse side built, backend not yet committed.** A Specific players list of 200 or
more holds back 10% by default (editable, 0 allowed); a shorter one nobody. The Clubhouse mirrors the backend's
`playersHoldout` (uncommitted in backend-offers `offer-campaigns.service.ts` on 2026-11-02): it sends the percent
only for 200+, shows the holdout control and "N held back to measure" (the count's `heldBack`) for those lists, and
compares results for them like any other offer. Until the backend ships it, a 200+ list sends its percent and an
older backend stores 0, so a save should read back NOT APPLIED on `holdoutPercent` (not tried) and the line says 0 (seen on the local backend).

## Match Ops › Offers: what the Clubhouse needs at release

**Decided by Ryan, 2026-10-30.** Ships by pushing feature/offers to main, never `vercel deploy --prod`.
Goes in the backend's `docs/offers/RELEASE-CHECKLIST.md` too. Read at `src/lib/offersConfig.ts`. Who may use it is not a variable: anyone with Match Ops access. Every one is server-only (none has a `NEXT_PUBLIC_` prefix). Anything unset or
wrong closes the whole page for everyone: every `/api/offers/*` route answers 503.

| Variable | Value | Notes |
|---|---|---|
| `OFFERS_ENV` | `local`, `staging` or `production` | No default. `local` needs local mode on; the other two need it off. |
| `OFFERS_API_BASE_URL` | `https://playmatchday.herokuapp.com` on production, `https://matchday-stage.herokuapp.com` on staging, `http://localhost:3070` on local | Bare origin. Its host must be the write client's own allowlisted host for that environment (`MATCHDAY_HOSTS`), so a new backend host is a code change, not a variable. |
| `OFFERS_UPLOAD_HOST` | The exact host in the backend's upload links, such as the S3 bucket's host. `localhost:3070` on local | Bare host, no scheme, path or wildcard. **The production value is UNKNOWN from here:** take it from the host in a real `POST /admin/offers/photo-uploads` answer on that environment. |

**Who may use it, decided by Ryan, 2026-10-30.** Anyone with Match Ops access (admin or
`can_access_matchops`) can view and do everything in Offers, including launching. There is no separate write
grant: someone with read-only Match Ops, without `can_edit_matches`, can launch an offer. This is deliberate,
not an oversight. Every write is still recorded under the signed-in person in `change_log` and sent to the
backend as `X-Acting-Staff-Email`.

**Staging.** Two ways to run it, and neither is set up on Vercel today. Offers itself is not on staging yet: on
2026-10-30, `GET /admin/offers/campaigns` on `matchday-stage.herokuapp.com` with no token answered 200 with an HTML
page, where `/admin/matches` answered 401.

Which Vercel scope gets what:

| Variable | Production scope | Preview scope |
|---|---|---|
| `OFFERS_ENV` | `production` | `staging` |
| `OFFERS_API_BASE_URL` | `https://playmatchday.herokuapp.com` | `https://matchday-stage.herokuapp.com` |
| `OFFERS_UPLOAD_HOST` | Production's upload host | Staging's upload host |
| `MATCHDAY_PROD_BASE_URL`, `MATCHDAY_PROD_API_EMAIL`, `MATCHDAY_PROD_API_PASSWORD` | Already there | **Never.** Keeping them off Preview is what stops a Preview build writing production |
| `MATCHDAY_STAGE_API_BASE_URL`, `MATCHDAY_STAGE_API_EMAIL`, `MATCHDAY_STAGE_API_PASSWORD` | Never | Add |

Seen with `vercel env ls` by name on 2026-10-31: no `OFFERS_*` or `MATCHDAY_STAGE_API_*` in any scope, and Preview
holds no `MATCHDAY_*` and no Supabase variable. So **a Preview build can't sign anyone in until
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are added to Preview
as well.** There is one Supabase project, so that gives Preview builds the production service-role key and production
data, which is a decision to make deliberately, not a step to tick. Whether Supabase's redirect list accepts a Preview
URL is UNKNOWN. A Preview build needs a pushed branch, and Offers writes from one land in the real `change_log` under
`env = staging`.

On a dev server instead, which needs none of that: set `OFFERS_STAGING_UPLOAD_HOST` to the host in a real staging upload
link and run `npm run dev:offers-staging`, port 3073, with `MATCHDAY_STAGE_API_*` in `.env.local`. Stop the local-mode
server first: one worktree can't run two dev servers. **Open only Match Ops › Offers on it.** It runs with local mode off,
so every other page there reads and writes production as usual.

Either way, staging's own `CLUBHOUSE_SERVICE_ACCOUNT_EMAILS` must list the `MATCHDAY_STAGE_API_EMAIL` account.

**Reads, decided 2026-10-30.** Every Offers read goes through the pacer at 2 seconds, except the page's load,
`GET /admin/offers/page`, which is one read in place of four. Create, launch, pause and end make no reads: the
backend checks them and each returns the campaign, which is the read-back and what the list takes.

**The pacer is per server instance.** It is in-process state (`src/lib/offersPacing.ts`), so on Vercel each running
instance has its own 2-second gap and its own 30-second stop. Two instances can read at the same moment, and a stop
on one doesn't reach another. It paces one person well. It is not a limit on what the Clubhouse as a whole sends.

**At the push, in this order:** release the backend; set the variables above in Production scope; `git fetch` and merge
`origin/main` into `feature/offers`, because the Clubhouse ships by pushing to main and this branch must carry what
main has; run `npm run verify` bare and read the exit code; push to main, never `vercel deploy --prod`; then
`git ls-remote origin refs/heads/main` is what says it landed. Variables set after the build don't reach it, so a late
one needs another deploy from a push.

A missing credential closes the page like any other variable: the routes answer 503 and the server log names it.

**No end date and the removable ticket need the backend's release, and the app.** The page sends them only when someone uses
them. A backend without them refuses in plain words. The app must handle `expiresAt: null` and `showTicket` before an
offer using either reaches a phone.

**Offer pushes (backend `docs/offer-push.md`) need the backend's push release.** Until then every push route answers
"This backend doesn't have offer pushes yet, so nothing was sent or saved." On production the push controls are hidden
from everyone except the emails in `OFFERS_PUSH_ACCOUNTS` (comma-separated, server-only, read in `pushesVisible`,
`src/lib/offersPush.ts`). Unset means nobody, and every push route answers 404 without reaching the backend. Staging and
local show them to anyone with Offers. Set it to Ryan's email for the first production check; who reaches a player is
still the API's `OFFER_PUSH_MODE`, which the Clubhouse never decides. None of it has been checked against a backend that
has the push routes: no staging run, no test push to a phone.

Also needed, none of them new variables:

- **Service-account credentials for that environment** (`MATCHDAY_PROD_BASE_URL`, `MATCHDAY_PROD_API_EMAIL`,
  `MATCHDAY_PROD_API_PASSWORD`, or the `MATCHDAY_STAGE_API_*` set). The write client signs in with these.
  The production three are already on Vercel, encrypted, Production scope (`vercel env ls production`,
  2026-10-30), so Offers needs no new credentials. **Check first:** read the value of `MATCHDAY_PROD_API_EMAIL`
  on Vercel. It is the email the next line needs, and it is UNKNOWN from here.
- That service account's email in the backend's `CLUBHOUSE_SERVICE_ACCOUNT_EMAILS`, or every Offers write is refused.
  The backend's `RELEASE-CHECKLIST.md` names `clubhouse-earnings@example.com`, which is the local seed account
  (`apps/api/tasks/seed-offers-local.mjs:40`), so that name needs replacing.
- CORS on the upload bucket for the Clubhouse origin, or the browser's PUT fails.

Not changed by these variables: `photoUrlOk` (`src/lib/offersModel.ts`) still accepts the local backend's
`http://localhost:3070/dev/uploads/` as well as any https address. The backend refuses that local address
outside local mode.

## Sign-out ends only this browser's session

**Decided by Ryan, 2026-10-30.** Ships on its own from origin/main, not with feature/offers.
Line numbers are origin/main at 8f2148a.

### Why

`supabase.auth.signOut()` with no argument defaults to `scope: "global"`
(`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:3153`, version 2.104.1). Global ends every
session that person has, on every device. The Clubhouse has one Supabase project, so a local dev
server and production share sessions: signing out of a worktree on localhost also ends the production
session, and the other way round.

Seen on 2026-10-30: a session on localhost:3072 stopped working mid-morning. Supabase answered its
token with 403 "Session from session_id claim in JWT does not exist", while the browser still held a
token that looked valid for another 13 minutes. **What revoked it is UNKNOWN.** A global sign-out is
one way to get there; nobody has shown it was this one.

### What to change

Three lines, all to `signOut({ scope: "local" })`:

| Where | What it is |
|---|---|
| `src/lib/useAuth.ts:108` | The Sign out button (`TopNav`, `MobileBottomNav`, `/no-access`) |
| `src/components/AuthGate.tsx:38` | Automatic: runs whenever a signed-in user has no `appUser` |
| `src/app/auth/callback/page.tsx:43` | Automatic: runs when the email has no `app_users` row |

The two automatic ones matter as much as the button, because nobody clicks anything for them to fire.
See "Related" below for how `AuthGate` can fire on a failed read.

Those three are every `auth.signOut` call under `src/` and `scripts/` on origin/main (`git grep`).
Grep again before shipping in case a new one has landed. No migration, and no change to any route.

### What changes for people

- Signing out in one browser leaves their other browsers and devices signed in.
- There is no "sign out everywhere" in the Clubhouse after this. A lost laptop's session has to be
  ended from the Supabase dashboard. Nothing in `src/` relies on the global behaviour today, and
  access is still read fresh from `app_users` on each request, so removing someone's row or rights
  still takes effect without their session ending.

### How to check it

The bar's default bucket: typecheck, look at it in a browser, push. It changes nothing a player is
charged and no match record, so it needs no new suite. Sessions are real, even on localhost, because
there is one Supabase project: use your own account and expect to sign in a few times.

1. `npm run verify`, run bare, and read the exit code.
2. Run the change on a local dev server. Sign in on two separate browser profiles, A and B, on the
   same origin. Both are the same person, and each gets its own session.
3. In A, click Sign out. A lands on the login page.
4. In B, reload and open any page that loads data. It should still load. In the network tab
   `/api/crm/threads/unread-count` should answer 200, not 401. This is the check that fails today.
5. In A, before signing out, copy the access token from localStorage, and after signing out send it
   to `/api/crm/threads/unread-count` as `Authorization: Bearer`. It should answer 401: local scope
   ends the session on the server too, it does not only clear the browser. The client does send the
   scope to the server (`GoTrueClient.js:3168`). The server's answer is UNKNOWN until this is run.
6. Control: sign back in on A and sign out on B. A should stay signed in. That proves step 4 was not
   a matter of which browser went first.

After pushing, `git ls-remote origin refs/heads/main` is what says it landed, and read the deployment
row rather than parsing a column. Then repeat steps 3 and 4 on production.

### Things that still sign out globally after this ships

- **Other worktrees.** `matchday-cockpit-mm`, `matchday-cockpit-covers`, `matchday-cockpit-offers` and
  the main clone each carry their own copy of these three lines, unchanged as of 2026-10-30. A Sign out
  on any of them, or an `AuthGate` sign-out, still ends every session, production included, until that
  worktree picks up the change.
- **Production tabs already open** run the old code until they reload.
- **The staff app** (`~/Code/matchday-clubhouse-app`) has its own: `src/lib/auth.tsx:98` (the button)
  and `src/lib/auth.tsx:65` (automatic, on an `ApiError`). Both use the default scope. Whether it
  shares this Supabase project is UNKNOWN; check before deciding if this change should reach it.

### Related, not part of this change

`src/lib/useAuth.ts`, `applyUser`, destructures only `data` from the `app_users` read and drops
`error`. A failed read (a network blip, a timeout, a 5xx) therefore looks the same as "this person has
no row": `appUser` is null, `AuthGate` signs them out and sends them to
`/login?error=not_authorized`. That comes from reading the code; it has not been reproduced. Today
that blip ends every session they have. Local scope limits it to the one browser but does not stop it,
and someone with access is still told they are not authorized. Fixing it means telling "no row" from
"could not read", and is a separate decision.

The rest of the Clubhouse also has no answer for a revoked session: pages keep rendering on a token
that looks valid while every API call returns 401. Only Match Ops › Offers says so (`SignInAgain` in
`src/components/offers/OffersView.tsx`, on feature/offers).
