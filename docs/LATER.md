# Later

Changes that are decided but not done. Each one ships on its own, by pushing to main, never
`vercel deploy --prod`. Delete an entry when it lands.

## Growth › Offers: what the Clubhouse needs at release

**Decided by Ryan, 2026-10-30.** Ships by pushing feature/offers to main, never `vercel deploy --prod`.
Goes in the backend's `docs/offers/RELEASE-CHECKLIST.md` too. Read at `src/lib/offersConfig.ts` and
`src/lib/offersAccess.ts`. Every one is server-only (none has a `NEXT_PUBLIC_` prefix). Anything unset or
wrong closes the whole page for everyone: every `/api/offers/*` route answers 503.

| Variable | Value | Notes |
|---|---|---|
| `OFFERS_ENV` | `local`, `staging` or `production` | No default. `local` needs local mode on; the other two need it off. |
| `OFFERS_API_BASE_URL` | `https://playmatchday.herokuapp.com` on production, `https://matchday-stage.herokuapp.com` on staging, `http://localhost:3070` on local | Bare origin. Its host must be the write client's own allowlisted host for that environment (`MATCHDAY_HOSTS`), so a new backend host is a code change, not a variable. |
| `OFFERS_UPLOAD_HOST` | The exact host in the backend's upload links, such as the S3 bucket's host. `localhost:3070` on local | Bare host, no scheme, path or wildcard. **The production value is UNKNOWN from here:** take it from the host in a real `POST /admin/offers/photo-uploads` answer on that environment. |
| `OFFERS_ALLOWLIST` | Comma-separated emails | Already exists. Unset means nobody. |

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
that looks valid while every API call returns 401. Only Growth › Offers says so (`SignInAgain` in
`src/components/offers/OffersView.tsx`, on feature/offers).
