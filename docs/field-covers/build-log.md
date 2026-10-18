# Field cover photos — build log

Local only. Nothing pushed, no PR, `main`/`master` untouched, no staging or production request made by this build.

- **Clubhouse:** `~/Code/matchday-cockpit-covers`, branch `feature/field-covers`, from `origin/main` 40bf981 (decision 7).
- **Backend:** `~/Code/backend-field-covers`, branch `feature/field-covers`, from `origin/master` 318da06. Its notes
  are in that worktree: `docs/field-covers/backend-notes.md`.

## 2026-10-17 / 18

| Step | Result |
|---|---|
| Worktrees + own DB `matchday_covers_local`, backend :3010, Redis db 5 | done |
| App caching check (item 10) | **PASS, no leak**. See below |
| Migration SQL shown, approved with ON UPDATE RESTRICT (Ryan) | applied locally; item 1 below |
| Backend: schema, endpoints, payload, upload tag, LOCAL_MODE images, seed | `afcd111`, `274c4f2`, `88ccd41` |
| Backend checks `verify_api.py` (items 3–8, API half of 4) | **39 / 39 PASS** on a fresh seed |
| Clubhouse: local mode (cherry-pick of 2abf976, repointed to :3010), `/api/covers/*`, two components, local page | `009aa6e`, `28802eb` |
| Clubhouse typecheck | clean |
| Clubhouse `npm run verify` | 101 / 107. The 6 failures need `.env.local`, which this worktree does not have; all 6 fail identically on untouched `origin/main` in the same worktree |
| Clubhouse in a browser (items 2, 4 from the Clubhouse, 9) | **NOT RUN.** Needs `.env.local` (Supabase sign-in); see "Blocked" |

### Found while building

- **Fixed: class-level `@Roles` left every cover route open to players.** `RolesGuard` reads handler metadata only.
  The script caught it (a player got 200); `@Roles` is now on each handler, and the script tries all 10 routes as a
  player.
- **Not fixed: `admin/stripe-accounts` on vendor `master` is open to any signed-in user** (the same class-level
  pattern). Proven locally (GET 200, PUT 200, and the row changed); production not probed. Facts doc entry, plus
  backend notes §6.2.
- **Documented, not fixed (Ryan): `updateMatch` UTC uses the old field's time zone.** Backend notes §6.1.

## Verification (each with its own verdict)

1. **Migration applied, verdict query shows the three schema changes: PASS** (2026-10-17, `matchday_covers_local`).
   - `field_covers` table present, 13 columns.
   - `matches.cover_id` nullable, `matches_cover_id_field_id_fkey FOREIGN KEY (cover_id, field_id) REFERENCES
     field_covers(id, field_id) ON UPDATE RESTRICT ON DELETE RESTRICT`.
   - `fields.merged_into_field_id` nullable, FK `upd=c del=n`, CHECK not self.
   - `field_covers_field_id_fkey` is `upd=r del=r`. `_prisma_migrations` shows `20261017120000_add_field_covers` applied.
   - `prisma migrate diff` between the live DB and the schema is empty.
2. **Add, rename, replace and remove a cover from the Clubhouse, each read back from the API: NOT RUN in a browser.**
   - The routes are built, and each verdict comes from an API read-back.
   - The backend side of all four is exercised by `verify_api.py`: add and remove directly; rename and replace are
     refused for a removed cover. Driving them from the Clubhouse page is what is outstanding.
3. **Remove shows the right count, and those matches read back on Default: PASS (API).**
   - The usage count was 6 upcoming = the database's 6.
   - Remove answered `upcomingMatchesReset 6, matchesReset 9`.
   - All 9 read back on Default via `admin/matches/:id/cover`, and the 6 upcoming ones via the app payload.
   - The row is soft-deleted with the staff email, and the cover can no longer be chosen (404) or renamed (404).
   - The Clubhouse confirmation dialog is not yet seen in a browser.
4. **Set a cover on one match, then apply it to others; read each back: PASS (API).**
   - Match 104 → Winter league read back, and the DB agrees.
   - The same-slot list (Tue 19:00: 103, 105, 106) matches the DB query.
   - Batch applied; each read back.
   - Staff rules: service without the header 400, non-service admin with the header 403, player 401 on all 10 routes
     with nothing changed.
   - The Clubhouse "Apply to other upcoming matches" box is not yet seen in a browser.
5. **A cover from another field is refused: PASS.**
   - Single → 400 `COVER_FROM_OTHER_FIELD`, and the match stays Default.
   - Batch → 400 naming the wrong match, and nothing written (all-or-nothing).
   - Raw SQL is refused by `matches_cover_id_field_id_fkey`.
   - Changing a cover's field while in use is refused (ON UPDATE RESTRICT).
6. **Moving a match to another field clears its cover: PASS.**
   - `PUT /admin/matches/110 {fieldId: NEMP}` (vendor `updateMatch`) → 200, and the match reads back on NEMP, on
     Default, with NEMP's default URL.
   - A raw move that keeps the cover is refused by the DB.
   - The FK error maps to a plain 409 with Ryan's wording (proven against the DB in a rolled-back transaction).
7. **A cloned week carries the cover: PASS.**
   - `POST /admin/matches/111/copy` → match 128 on Night games.
   - `POST /admin/matches/copy-by-week` 2026-10-26 → 2026-11-30: the five copies have the same covers as their sources
     (Default, Winter league, Default, Night games, Night games).
8. **The match payload shows the resolved cover in `match.field.cover` and `match.coverUrl`; `GET /fields/:id` still
   shows the default: PASS.**
   - Covered: `GET /matches/:id`, `GET /admin/matches/:id`, `GET /matches` (list), `GET /matches/my-matches`,
     `GET /admin/matches` (list), each for a Night games match and a Default match.
   - No raw `cover` key on any of them.
   - `GET /fields/:id` and `GET /fields` show Parmer's Default.
   - Not covered: `GET /matches/matches-for-review` and the v1 admin list. They use the same DTOs and queries
     (`findAllMatchesForReview` includes `cover`), but no request was made.
9. **Crop previews render for all four shapes: NOT RUN.** Needs the browser (see "Blocked").
10. **App caching check: PASS, no leak.** Read-only, `~/Code/frontend-prod-current` 7644fb0, cross-checked on
    `~/Documents/frontend` feature/match-manager-track.
    - The Field Partners list reads only `GET /fields`: `screens/OurLocationScreen.tsx:39-43`,
      `components/FieldsCarousel.tsx:34-35`, and `FieldCard.tsx:24-27` renders its prop.
    - Field detail reads only `GET /fields/:id`: `screens/fieldDetails/FieldDetails.tsx:46-49`, hero `:65-67`.
    - Navigation passes `fieldId` only: `MainStackParamList.ts:36-38` `{ fieldId?: number }`;
      `MatchDetails.tsx:436` passes `match.field.id`.
    - The only `setQueryData` calls write `profile` keys (`EditProfileScreen.tsx:277,320`, `HomeScreen.tsx:868`).
    - Redux persist saves only `['auth','notifications']` (`store/index.ts:49`). No RTK Query or entity adapter.
    - **Two places show the per-match cover, which is expected:**
      - the upcoming-games strip on the field detail screen (`components/UpcomingGamesCarousel.tsx:146-148`);
      - the go.playmatchday.com share image and page (`lib/matchday.ts:90` → `opengraph-image.tsx:91`, `page.tsx:59`).

## Blocked

The Clubhouse signs in through production Supabase, and its keys are in `~/Code/matchday-cockpit/.env.local`.
Reading that file is blocked for this session by a deny rule, so I did not link it into this worktree.
`.env.development.local` here holds only the non-secret local-mode flags.

With `.env.local` linked, the outstanding steps are:
- run `next dev -p 3012`;
- sign in with the repo's `storageStateFor()` helper;
- drive `/match-ops/field-covers` for items 2, 4 and 9, and confirm the remove dialog's count (item 3) in the browser.

## Not done / scope

- The Clubhouse components render nothing outside local mode, because `/api/covers/status` says unavailable. When the
  backend ships, `coversEnv()` in `fieldCoversServer.ts` is the one place that picks the production target, and:
  - the Fields drawer's old **Cover image** control is the same Default, so it should fold into COVER PHOTOS rather
    than show twice;
  - `matchops-auth-test`'s census counts direct importers of the Match Ops gate, while `/api/covers/*` goes through
    `coversGate`. Teach the census about it then.
- No browser suite was written. The checks are `verify_api.py` (backend) and, once unblocked, a look in the browser.
  That fits the bar: this is display, not money or match records.
- No merge tooling for fields 17 and 18; the column only.
- No app or website code changes, as planned.
