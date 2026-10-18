# Field cover photos and field merge — staging and production launch checklist

Nothing here has run. Both branches are local only:
- **backend**: `~/Code/backend-field-covers` `feature/field-covers`, from `master` 318da06;
- **Clubhouse**: `~/Code/matchday-cockpit-covers` `feature/field-covers`, from `origin/main` 40bf981.

Each box is a check with a recorded result (LANDED / FAILED / NOT APPLIED / UNKNOWN, and where you read it), not a
step to tick past.

**Order:** backend to staging → staging checks → backend to production → Clubhouse to production (push to `main`;
never `vercel deploy --prod`) → the merge, staging first, then production in small steps.

---

## 0. Before anything ships

- [ ] **The Stripe accounts guard is fixed first** (separate change, backend notes §6.2). A deploy of this branch must
      not carry the same class-level `@Roles` mistake. The field-covers controller has `@Roles` on every handler; re-run
      the class-level scan (backend notes §6.2) on the merged branch.
- [ ] **The two branches are merged with the Match Manager branches.**
  - Backend duplicates to collapse to one copy: `staff-identity.ts`, `s3PublicUrl`, `isLocalMode`.
  - Clubhouse: `mmStaffIdentity.ts`, and `apiWrite`'s `actingStaffEmail` (identical on both).
  - `localMode.ts`: both branches change `LOCAL_MDAPI_HOST` (3000 vs 3010). Pick one, or make it a setting.
- [ ] **Migrations reviewed in order.** `20261017120000_add_field_covers` (approved 2026-10-17), and
      `20261018120000_add_field_merges` if approved. Both run in Heroku's release phase before the new dyno starts.
  - The old code serves for a moment against the new schema. That is safe: `cover_id` is NULL everywhere until someone
    sets one, and the two-column FK never checks a NULL.
- [ ] **The `updateMatch` UTC bug** (backend notes §6.1) is either fixed in its own change first, or written down as known.
  - The merge refuses cross-city merges, so it cannot hit the bug itself. A staff field move across time zones still can.
- [ ] **Clubhouse:**
  - `coversEnv()` (`src/lib/fieldCoversServer.ts`) picks production. Today it returns `local` or null.
  - `matchops-auth-test`'s census learns that `/api/covers/*` goes through `coversGate`.
  - The `PRODUCTION_WRITES_ENABLED` bolt stays as it is.

## 1. Real S3 upload path for the new `extraCover` tag (staging)

- [ ] **The upload link:** `POST /files {entity:"field", entityContent:"extraCover", entityId, contentType}` returns
      `uploadURL`, `fileKey` (`images/<uuid>`) and `header`. Production's response shape was UNKNOWN before this branch;
      read it, don't assume.
- [ ] **The host guard:** the PUT goes to `matchday-stage.s3.us-west-1.amazonaws.com` over https. The Clubhouse refuses
      any other parsed host (`assertCoverUploadHost`).
- [ ] **The object:** it exists with the `public-read` ACL and its `x-amz-tagging` reads `field=<id>&image=extraCover`.
- [ ] **The webhook ignores `extraCover`:** after the S3 notification fires, the field's **gallery has not grown** and
      `fields.cover_s3_key` is unchanged. Before this branch an unknown tag fell into the gallery branch.
- [ ] **Register needs `HeadObject`:** it uses `HeadObject`, which needs `s3:GetObject` on the bucket for the API's AWS
      user. UNKNOWN whether that user has it.
  - A missing permission shows as `UPLOAD_NOT_FOUND` on every register.
  - Check with one upload; read the error before changing IAM.
- [ ] **Replace the Default from COVER PHOTOS:** `fields.cover_s3_key` changes; the old `/api/fields/photos` cover upload
      folds away.

## 2. The current store app shows covers (staging build)

The current App Store and Play builds need no code change; they read `match.field.cover`. Check on both platforms.
Wherever a cover should show, `field.cover` and `coverUrl` are the same value.

- [ ] **Match card in the list:** a match on an extra cover shows that photo, and a match on Default shows the Default.
- [ ] **Match details header:** the first image is the match's cover. The gallery after it is the field's gallery.
- [ ] **My Matches:** both an upcoming match and a played match keep the cover; for a played match that includes a
      removed cover.
- [ ] **Field detail:** the hero is the field's **Default** (`GET /fields/:id`). The "upcoming games" strip shows each
      match's own cover; that is expected (app check, item 10).
- [ ] **Cached screens:** nothing in the app caches a field taken from a match payload (item 10: React Query keys,
      Redux persist whitelist `auth`/`notifications`). Kill and reopen the app after changing a cover anyway.

## 3. Field Partners stays on the Default

- [ ] **Home "OUR FIELD PARTNERS" carousel and VIEW ALL:** the Default, even when every upcoming match at that field
      uses another cover (`GET /fields?cityId=`).
- [ ] **`GET /fields/:id` and `GET /fields`:** the Default, read from the API.

## 4. go.playmatchday.com previews

- [ ] **`/match/<id>` page and its 1200×630 image:** a match on an extra cover shows it, because `lib/matchday.ts:90`
      reads `field.cover`. A played match on a removed cover still shows it.
- [ ] **Which API the site reads:** check `API_URL` in its environment before testing against staging.
- [ ] **Messaging-app caches:** iMessage, WhatsApp and Slack cache the image per URL, so a cover changed after a link was
      shared does not update in that thread. Expected. Say it to staff once.
- [ ] **`/field/<id>`:** static text. A merged field's old id should still render.

## 5. Weekly clone (staging)

- [ ] **`POST /admin/matches/clone-by-week` and `copy-by-week`:** each copy carries its source's `cover_id`.
- [ ] **A copied past week whose cover was removed since:** the copy shows the **Default** in the app, not the removed
      photo. (The resolver serves a removed cover only on matches that have started.)
- [ ] **The vendor's 07:00 non-production cron** rewrites the dates of matches with id < 15 on staging. Use higher ids.

## 6. Retool, moving a match that has a cover (staging)

- [ ] **Retool's `updateMatch` with a new `fieldId`** on a match that has a cover: expect **200**, and the match back on
      the new field's Default. The service clears the cover in the same UPDATE, so Retool should never see an error.
- [ ] **The 409 for paths that skip the service:** "This match has a cover photo from its current field. Set the match's
      cover photo back to Default in the Clubhouse (Gameday Ops, Cover photo), then change the field." Reproduce it on
      staging only through a path that skips the service. If none exists, record that and don't invent one.

## 7. The field merge — staging first

Once the `field_merges` migration is approved and deployed:

- [ ] **Preview 18 → 12 on staging** (`GET /admin/fields/18/merge-into/12/preview`). Read the left-behind list to Ryan:
  - promo codes on the old field only;
  - phone numbers;
  - gallery;
  - special events;
  - reminder config.
  Decide each before merging (Ryan's call: what happens to promo codes restricted to the old field).
- [ ] **Merge 18 → 12**, then read back:
  - every id in `moved_match_ids` is on 12, with the carried cover;
  - every match that had started is still on 18;
  - 18 has `deleted_at` and `merged_into_field_id = 12`;
  - `GET /fields/18` answers with field 12;
  - the app opens a `field/18` deep link on field 12;
  - the Clubhouse Fields list no longer shows 18;
  - a played match on 18 still shows its cover, and its share link still renders.
- [ ] **Then 17 → 10 on staging**, same checks. 17 has an extra cover in use, and that cover must arrive on 10 by name.
- [ ] **Clubhouse-side ids keyed by field (not in the backend):**
  - `fin_venue_fields` venue mapping: moved matches cost against field 10's venue from now on;
  - Field P&L history stays on 17;
  - Stripe charge metadata `fieldId` on past charges stays 17.
  Decide whether finance needs a note or a mapping change.
- [ ] **A rollback path written down from the `field_merges` row** before production:
  - move `moved_match_ids` back to the old field;
  - point their `cover_id` back from `cover_map`;
  - clear `deleted_at` and `merged_into_field_id`.
  Do it on staging once.

## 8. Production, in small steps

- [ ] **Deploy the backend.** Before touching any cover, read back `GET /fields`, `GET /matches/:id` and the app, and
      confirm nothing changed.
- [ ] **Push the Clubhouse to `main`.** Confirm with `git ls-remote origin refs/heads/main`, then look at the Fields
      drawer and the Gameday Ops panel in production.
- [ ] **First cover:** add **one** cover to **one** field, set it on **one** upcoming match, read back via the API, the
      app and the share preview, then remove it and read back the Default.
- [ ] **Apply to other matches** on one slot. The ticked matches change and an unticked one keeps its cover.
- [ ] **Preview each merge in production** (read only). Settle the left-behind items.
- [ ] **Merge 18 → 12.** Watch a day of matches at 12, including cancellations and promo use. Then merge 17 → 10.
- [ ] **After each step, the change log has a row** with `source` "Field covers · …". Its `source` is free text
      (`0113_change_log.sql:16`), so no constraint migration is needed.
