# Field cover photos — decisions

Ryan's calls are marked **(Ryan)**. The rest are build-time calls made on ordinary ambiguity, each with its reason, so
any of them can be reversed.

## Ryan, 2026-10-17

1. **Covers are not tied to match category or type (Ryan).** Default plus named extras. A match uses Default or one
   cover of its own field.
2. **Migration SQL approved (Ryan)**, with one change: the `matches (cover_id, field_id)` FK is **ON UPDATE RESTRICT**.
   CASCADE would rewrite `field_id` on every match using a cover whose field changed, which silently moves matches
   between fields.
   - The other new FKs were checked: `field_covers.field_id → fields` also became RESTRICT, because covers never change
     field.
   - The three `*_by_user_id → users` keys stay CASCADE: they are attribution only, and nothing moves.
   - `fields.merged_into_field_id → fields` stays CASCADE: a renumbered target is still the same field.
3. **Keep the two-column FK (Ryan).** A loud failure beats a wrong photo. A NULL `cover_id` is never checked, so
   ordinary field moves are unaffected. The service maps the FK error to a plain 409: "This match has a cover photo from
   its current field. Set the match's cover photo back to Default in the Clubhouse (Gameday Ops, Cover photo), then
   change the field."
4. **Names (Ryan):** 60 characters, unique per field ignoring case, "Default" refused.
5. **Who set a match's cover lives in the change log only (Ryan).** No new columns on `matches`.
6. **The `updateMatch` UTC bug is documented, not fixed, on this branch (Ryan).** It gets its own change in the backend
   phase. See the backend notes.

## Build-time calls

7. **The Clubhouse branch is based on `origin/main` (40bf981), not local `main`.**
   - Local `main` was 3 ahead and 58 behind. All 3 of its commits are on `origin/main` under other hashes:
     `bd32327` → `092eb5c` (patch-identical), `34bb9be` → `74e5f3e`, `d61a1f4` → `2dab33f`.
   - For the last two, the changed lines are identical and only the surrounding context differs. Nothing is stranded.
8. **A local-mode-only page, `/match-ops/field-covers`, hosts the two components.**
   - The Fields drawer and the Gameday Ops panel read production (the MatchDay API, plus production Supabase mirrors
     such as `mdapi_matches` and `fin_venue_fields`), and local mode refuses that read client.
   - Pointing those pages at seed data would mix seed match ids (100 to 127) with production mirror rows.
   - So the components are mounted in their real homes, where they render nothing until the backend ships, and the
     local page is where they are built and checked. It 404s outside local mode and is not in the nav.
9. **Uploads go through the Clubhouse server, as the existing field photo upload does** (`/api/fields/photos`). The
   bytes go to the route, and the route PUTs them after a host guard on the parsed host:
   - local mode: exactly `http://localhost:3010`;
   - later: the production S3 host.
   No non-GET leaves the browser unguarded.
10. **Extra covers are registered synchronously.**
    - The vendor's `POST files` flow attaches images asynchronously (S3 → SNS → `files-response` reads the object
      tags). An extra cover needs a name, which a tag cannot carry cleanly, and a verdict that is not "PENDING".
    - So `POST files` gains a new tag, `entityContent: extraCover`, and returns the `fileKey` (additive).
    - The browser-side route PUTs the bytes, then registers the key with `POST admin/fields/:id/covers {name, fileKey}`.
      The backend checks that the object exists (S3 HEAD, or local disk).
    - The webhook **ignores** `extraCover`. Without that it would fall into the gallery branch and add the image as a
      gallery photo.
11. **The match cover is its own commit**, not part of MatchPanel's staged Save. It is a separate endpoint, and the
    panel's diff/Save model must stay "only what changed on the match".
12. **Removing a cover sends only matches that have not started back to Default; started ones keep it (Ryan,
    2026-10-18).** This replaces the first build, which cleared past matches too.
    - The resolver serves a removed cover only on a match that has started (`hasStarted` on `start_date_utc`, true
      UTC).
    - Cancelled matches that have not started are cleared as well (they are not history). "Upcoming" in the counts is
      the cards' rule: not cancelled, not started.
    - A past week copied forward carries the removed id and shows the Default (check in `verify_api.py`).
13. **"Same slot" for Apply** means: same field, not cancelled, not started, and the same weekday and HH:MM of the
    wall-clock `startDate`. The current match is excluded, and so are matches already on the chosen cover.
14. **Resolution lives in one place on the backend**: `MatchForResponseDto`, a class-transformer `@Transform`.
    - Proven by experiment that it is inherited by every subclass that redeclares `field`, and that it sees the
      already-converted field.
    - The six match queries that feed payloads include `cover: { select: { s3Key, deletedAt } }`. The raw relation is
      dropped from the payload.
    - A match with `cover_id` whose query did not include `cover` logs one warning and shows the Default rather than
      a wrong photo.
15. **The backend endpoints are ADMIN-only** (the Match Manager admin guard), not the vendor's city-manager-or-admin
    guard. The brief said "same guard as the Match Manager admin endpoints".
16. **Grant used in the Clubhouse: EDIT MATCHES** (`can_edit_matches`), as the brief suggested. No reason was found to
    differ: a cover changes what a match looks like to players, the same class of change as editing the match.
17. **`apiWrite` gains `actingStaffEmail`**, with the exact signature already on `feature/match-manager-track`.
    `mmStaffIdentity.ts` is copied unchanged, so the two branches merge cleanly. Keep one copy when both ship. The
    backend's `staff-identity.ts` is likewise a copy of the Match Manager one.
18. **Local image storage**: `LOCAL_MODE=true` on the backend writes uploads to `apps/api/uploads/images/` and serves
    them at `/dev/uploads/images/<uuid>`.
    - The API refuses to start with `LOCAL_MODE=true` if any `AWS_*` setting is present or `NODE_ENV=production`
      (ported from the Match Manager branch's video storage).
    - `s3PublicUrl` (same name and contract as on the Match Manager branch) builds local URLs in local mode only.
19. **Isolation from the Match Manager session**:
    - backend on port 3010, Redis database 5 (the Match Manager backend uses database 0, and shared Bull queue names
      would let each API take the other's jobs);
    - database `matchday_covers_local`;
    - Clubhouse local target `localhost:3010`, on port 3012.
20. **`VERCEL=` is blanked in this worktree's `.env.development.local`.** `.env.local` is a `vercel env pull` file
    and (inferred, not read) sets `VERCEL`, which turns local mode off: the local page answered 404 until it was
    blanked, and rendered straight after. Under `next dev` only; nothing deploys from here.
21. **The local page lists past matches** by sending `fromDate` to `GET /admin/matches`. Without it the backend starts
    the list 15 minutes ago (facts doc).
22. **The local page reloads its match panel after a cover write on the field side** (`onChanged`). Without it the panel
    kept showing a cover that had just been removed.
