# Field cover photos — build log

Local only. Nothing pushed, no PR, `main`/`master` untouched, no staging or production request made by this build.

- **Clubhouse:** `~/Code/matchday-cockpit-covers`, branch `feature/field-covers`, from `origin/main` 40bf981
  (decision 7).
- **Backend:** `~/Code/backend-field-covers`, branch `feature/field-covers`, from `origin/master` 318da06. Its notes
  are in that worktree: `docs/field-covers/backend-notes.md`.

## Re-run everything

```bash
# backend (API on :3010), fresh seed, then the API checks (they write; reseed after)
cd ~/Code/backend-field-covers/apps/api && npx prisma db seed && python3 -I ../../docs/field-covers/verify_api.py
# Clubhouse on :3012 (local mode via .env.development.local; .env.local is a symlink to the main clone's)
cd ~/Code/matchday-cockpit-covers && npx next dev -p 3012
# browser checks (fresh seed first): writes screenshots to $SHOTS
SHOTS=docs/field-covers/screens IMG_SQUARE=<a square jpg> IMG_TALL=<a tall jpg> \
  node --env-file=.env.local scripts/_check_field_covers.mjs
```

## Log

| When | Step | Result |
|---|---|---|
| 10-17 | Worktrees, own DB `matchday_covers_local`, backend :3010, Redis db 5 | done |
| 10-17 | App caching check (item 10) | **PASS, no leak** |
| 10-17 | Migration SQL shown, approved with ON UPDATE RESTRICT (Ryan), applied locally | item 1 |
| 10-17 | Backend: schema, endpoints, payload, upload tag, LOCAL_MODE images, seed | `afcd111`, `274c4f2` |
| 10-18 | Fix: class-level `@Roles` left the cover routes open to players | `88ccd41` |
| 10-18 | Stripe accounts guard finding (vendor `master`), read-only analysis and contractor message | facts doc, backend notes §6.2 |
| 10-18 | Remove rule changed (Ryan): only matches that have not started go back to Default | backend `2b741e1`, Clubhouse copy |
| 10-18 | Backend checks `verify_api.py` | **45 / 45 PASS** on a fresh seed |
| 10-18 | Clubhouse in a browser, `_check_field_covers.mjs` | **34 / 34 PASS**, 13 screenshots in `screens/` |
| 10-18 | Clubhouse typecheck | clean |
| 10-17 | Clubhouse `npm run verify` (before `.env.local` was linked) | 101 / 107. The 6 failures needed `.env.local`, and fail the same on untouched `origin/main` in this worktree |
| 10-18 | Clubhouse `npm run verify` with `.env.local` linked, at the final tree | **107 / 107, exit 0** |

### Found while building

- **Fixed: a class-level `@Roles` is ignored by `RolesGuard`.** It left all ten cover routes open to players until
  `@Roles` went on each handler.
- **Not fixed: `admin/stripe-accounts` on vendor `master` is open to any signed-in user.** Facts doc, plus backend
  notes §6.2.
- **Documented, not fixed (Ryan): `updateMatch` computes UTC in the OLD field's time zone.** Backend notes §6.1.
- **`GET /admin/matches` hides past matches unless `fromDate` is sent** (facts doc). It made one browser check pass on
  an empty set until a positive control was added. That check now proves the read-back covers exactly the dialog's
  counts.
- **Local mode was off under `next dev` with the real `.env.local`**, because that file sets `VERCEL`. Fixed by
  blanking it in this worktree's `.env.development.local` (decision 20).

## Verification (each with its own verdict)

1. **Migration applied; the check query shows the three schema changes: PASS** (2026-10-17, `matchday_covers_local`).
   - `field_covers`: 13 columns.
   - `matches_cover_id_field_id_fkey FOREIGN KEY (cover_id, field_id) REFERENCES field_covers(id, field_id) ON UPDATE
     RESTRICT ON DELETE RESTRICT`.
   - `fields.merged_into_field_id` nullable, with FK and CHECK.
   - `field_covers_field_id_fkey` RESTRICT / RESTRICT.
   - `prisma migrate diff` between the live DB and the schema is empty.
2. **Add, rename, replace and remove from the Clubhouse, each read back from the API: PASS (browser).** Each step's
   verdict is LANDED, read back from `localhost:3010` directly:
   - add "Rooftop lights" (cover 4 listed);
   - rename to "Rooftop lights Friday" (API name matches);
   - replace image (API url changed, and the new image serves as `image/jpeg`);
   - remove (gone from the list);
   - also: replace the Default (API Default url changed).
   - Screens 01, 04, 05, 10.
3. **Remove shows the right count, and those matches read back on Default: PASS (API and browser), on the new rule.**
   - Browser, new cover: "Remove “Rooftop lights Friday”? 4 upcoming matches go back to Default." Then LANDED, and 4
     upcoming read back on Default.
   - Browser, Night games: "… 4 upcoming matches go back to Default. 3 past matches keep it, so its history and old
     share links look the same." Then LANDED, 4 upcoming on Default, 3 past still on it, marked removed.
   - Positive control: the read-back covers exactly the dialog's 4 and 3.
   - The played match's panel says "Removed from the field. This match has been played, so it keeps the photo." and
     shows the Night games image.
   - The open match panel reloads to Default.
   - API (`verify_api.py`): usage 6 upcoming / 3 past = DB. Remove → `upcomingMatchesReset 6, notStartedCleared 6,
     pastMatchesKept 3`. The DB still points the 3 past matches at the removed cover. The app payload serves its image
     for them (image loads, 200 `image/jpeg`); upcoming ones serve the Default. Soft-deleted with the staff email. Can't
     be chosen (404) or renamed (404).
   - Edge: a past week copied into the future carries the removed id but shows the Default.
   - Screens 09, 11, 12, 13.
4. **Set a cover on one match, then apply it to others; read each back: PASS (browser and API).**
   - Match 104 starts on Default.
   - Change lists Default + the field's 3 covers.
   - Save → LANDED, and the API agrees.
   - The apply offer is exactly the API's same-slot upcoming matches (103, 105, 106), all ticked.
   - Apply → LANDED, each read back.
   - API: staff header rules hold, and a player is refused on all 10 routes with nothing changed.
   - Screens 06, 07, 08.
5. **A cover from another field is refused: PASS (API).**
   - Single and batch requests are refused with a 400.
   - The batch writes nothing.
   - Raw SQL is refused by the FK, and a cover in use can't change field.
6. **Moving a match to another field clears its cover: PASS (API).**
   - The vendor `updateMatch` moves it to NEMP on Default.
   - A raw move that keeps the cover is refused.
   - The FK error maps to the plain 409.
7. **A cloned week carries the cover: PASS (API).** Both `:matchId/copy` and `copy-by-week`.
8. **Match payload shows the resolved cover in `match.field.cover` and `match.coverUrl`; `GET /fields/:id` still
   shows the default: PASS (API).**
   - Covered: 5 match endpoints × (cover, Default), plus `GET /fields/:id` and `GET /fields`.
   - Not requested: `matches-for-review` and the v1 admin list.
9. **Crop previews render for all four shapes: PASS (browser).**
   - Default + tall image: card 1.669, header 1.333, Field Partners 1.618, share 1.905. Each frame has the image, and
     the guide is drawn.
   - Extra cover + square image: the same, minus Field Partners (Default only).
   - Screens 02, 03.
10. **App caching check: PASS, no leak** (2026-10-17, read-only; details in the first report and the spec).

## Not done / scope

- The Clubhouse components render nothing outside local mode. When the backend ships, `coversEnv()` picks the
  production target, and:
  - the Fields drawer's old **Cover image** control should fold into COVER PHOTOS;
  - the `matchops-auth` census should learn that `/api/covers/*` goes through `coversGate`.
- The real Fields drawer and Gameday Ops panel were not loaded with the components in them. They read production and
  refuse local mode (decision 8). The local page hosts the same components.
- The local page's match panel renders nothing for a moment while it reloads after a cover write (seen in screen 12).
- No merge tooling for fields 17 and 18; the column only.
- `_check_field_covers.mjs` is a local browser check, not part of `npm run verify`. It needs both local servers.
