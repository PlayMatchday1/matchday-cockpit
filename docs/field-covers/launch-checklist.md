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

**2026-11-02: covers ship in 1.88 inside feature/offers (merge `d6515fb` in the Clubhouse, `dcb2b98` in the backend).
The field merge (17 NEMP Tournaments, 18 Round Rock Tournaments) does NOT ship in 1.88: sections 7 and 8's merge steps
are under "Later" at the end.**

- [x] **The Stripe accounts guard is fixed first.** Done on feature/offers (Ryan, 2026-11-02).
- [x] **The branches are merged.** Clubhouse: covers uses `staffIdentity.ts` (Offers'), `mmStaffIdentity.ts` is gone;
      `localMode.ts` takes the local backend host from `MATCHDAY_LOCAL_API_HOST` (localhost:<port> only, default 3070).
      Backend: tab 1's merge `dcb2b98`. The Match Manager branches are not part of 1.88 and are not merged.
- [ ] **Migrations reviewed in order.** `20261017120000_add_field_covers` (approved 2026-10-17). It is dated before
      every Offers migration (20261030 onward); Prisma still applies it, but check the order `migrate deploy` prints on
      staging. `20261018120000_add_field_merges` is only a table and is harmless unused; whether it ships with 1.88 is
      the backend session's call.
- [ ] **S3 permission, BEFORE STAGING (Ryan, in AWS).** What the code shows, from code and config only (no secret read):
  - The API signs in to S3 as one IAM user per Heroku app: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, bucket
    `AWS_BUCKET` in `AWS_REGION` (`apps/api/src/config/aws.config.ts`). The repo holds no IAM policy, Terraform or
    bucket policy, so the permission cannot be read from here.
  - Production code today (master `318da06`) calls only `PutObject` (signing the upload link) and `GetObjectTagging`
    (the upload webhook), so production proves `s3:PutObject` and `s3:GetObjectTagging` and nothing about `GetObject`.
  - 1.88 adds `HeadObject` (covers register `imageExists`, and Offers' `addCacheControl`), which S3 authorises as
    **`s3:GetObject`**, and `CopyObject` onto the same key with `ACL: public-read` and `TaggingDirective: COPY`
    (Offers' cache header), which needs **`s3:GetObject`, `s3:PutObject`, `s3:PutObjectAcl`, `s3:GetObjectTagging`
    and `s3:PutObjectTagging`**. So this is an Offers prerequisite too, not only covers.
  - **The exact check**, for staging and production separately: Heroku dashboard, the API app, Settings, Reveal Config
    Vars, read only the *value of* `AWS_ACCESS_KEY_ID` (the key id, not the secret) and `AWS_BUCKET`. AWS console, IAM,
    Users, search that access key id (Access keys column) to find the user. Its Permissions tab: open every attached
    and inline policy (and any group's) and look for an `Allow` on `arn:aws:s3:::<AWS_BUCKET>/*` covering each action
    above (or `s3:*`). Then S3, the bucket, Permissions, Bucket policy: look for a `Deny` on those actions for that
    user. Optional proof: IAM, Policy simulator, pick the user, service S3, the five actions, resource
    `arn:aws:s3:::<AWS_BUCKET>/images/test.jpg`, Run simulation; each should say allowed.
  - Record the user, the policy names and the five answers here. Missing: decide the policy change before staging.
- [ ] **`POST /files` answer on production: UNKNOWN.** Measured only on staging, 2026-08-29: `{ uploadURL }` and no other
      key, `X-Amz-SignedHeaders=host`, the tag in the signed query string (`docs/matchday-api-facts.md`, FIELD IMAGES;
      `src/lib/fieldPhotos.ts`). The master DTO declares `uploadURL` and an optional `header`. The merged backend adds
      `header` (always) and `fileKey`.
  - **What covers needs** (`uploadCoverImage`, `src/lib/fieldCoversServer.ts`): `uploadURL` and `fileKey`, both
    strings. Either missing is FAILED ("came back without a URL or a file key") and nothing is uploaded. `header` is
    not read. The PUT goes to the parsed host `S3_HOSTS[env]` over https only, sends `Content-Type` and the bytes, no
    Authorization and no `x-amz-tagging` header.
  - **Why the tag header question is open**: the signer is told `unhoistableHeaders: new Set('x-amz-tagging')`, which
    makes a set of single characters, not the header name, so the SDK still hoists the tag into the query string. That
    matches staging's `SignedHeaders=host`. If someone "fixes" that line, the tag becomes a signed header and every
    upload without it fails with 403 SignatureDoesNotMatch. Section 1 checks it on staging.
  - This only matters once the merged backend is deployed: covers cannot upload against today's production, which
    sends no `fileKey`.
- [ ] **The `updateMatch` UTC bug: written down as known for 1.88, not fixed** (backend notes 6.1; backend-owned).
      Moving a match to a field in another time zone leaves `start_date_utc` on the old zone's offset. For covers this
      means a cross-zone moved match can be judged started or not started an hour off, which decides whether a removed
      cover still shows on it. Same-zone moves (all Texas fields) are unaffected.
- [x] **Clubhouse:**
  - `/api/covers/*` use the Offers config (`OFFERS_ENV`, `OFFERS_API_BASE_URL`, credentials): local, staging or
    production, wherever Offers points (`4fef09e`).
  - `matchops-auth-test`'s census pins every `/api/covers` route and handler to `coversGate`, and the gate's order.
  - The `PRODUCTION_WRITES_ENABLED` bolt is unchanged.

## 1. Real S3 upload path for the new `extraCover` tag (staging)

- [ ] **The upload link (records the answer section 0 calls UNKNOWN):** `POST /files {entity:"field",
      entityContent:"extraCover", entityId, contentType}` on staging. Record the keys of the answer (expect `uploadURL`,
      `fileKey` as `images/<uuid>`, `header`), and from `uploadURL` the value of `X-Amz-SignedHeaders` and whether
      `x-amz-tagging` is in the query string. `SignedHeaders` must be `host` alone, or covers' PUT (no tag header) fails.
      Then the same on production, read-only in effect (it creates no row), before the first production cover.
- [ ] **The host guard:** the PUT goes to `matchday-stage.s3.us-west-1.amazonaws.com` over https. The Clubhouse refuses
      any other parsed host (`assertCoverUploadHost`).
- [ ] **The object:** it exists with the `public-read` ACL and its `x-amz-tagging` reads `field=<id>&image=extraCover`.
- [ ] **The webhook ignores `extraCover`:** after the S3 notification fires, the field's **gallery has not grown** and
      `fields.cover_s3_key` is unchanged. Before this branch an unknown tag fell into the gallery branch.
- [ ] **Register needs `HeadObject`:** one real upload and register on staging, read back. It confirms the
      `s3:GetObject` answer from section 0 (a missing permission shows as `UPLOAD_NOT_FOUND` on every register).
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

## 7. Production, in small steps

- [ ] **Deploy the backend.** Before touching any cover, read back `GET /fields`, `GET /matches/:id` and the app, and
      confirm nothing changed.
- [ ] **Push the Clubhouse to `main`.** Confirm with `git ls-remote origin refs/heads/main`, then look at the Fields
      drawer and the Gameday Ops panel in production.
- [ ] **First cover:** add **one** cover to **one** field, set it on **one** upcoming match, read back via the API, the
      app and the share preview, then remove it and read back the Default.
- [ ] **Apply to other matches** on one slot. The ticked matches change and an unticked one keeps its cover.
- [ ] **After each step, the change log has a row** with `source` "Field covers · …". Its `source` is free text
      (`0113_change_log.sql:16`), so no constraint migration is needed.

## Later: not in 1.88

- **The field merge** (17 NEMP Tournaments, 18 Round Rock Tournaments). Ryan, 2026-11-02: does not ship in 1.88.
  The target fields are not settled (the seed used 10 and 12; the real NEMP and Round Rock field ids are UNKNOWN
  here), and the merge moves venue costs (17 and 18 carry `counts_as_regular_play = false` links at $77 a match).
  Offers' `applies_field_ids` and Played-at `field_ids` reference fields with no foreign key, so the merge should
  also report offers scoped to the old field. The steps that were sections 7 and 8 follow, unchanged.
- **Match Manager branch duplicates** (`mmStaffIdentity.ts` and its `whoDid`), when that branch ships.
- **Folding the old "Cover image" control** in the Fields drawer into COVER PHOTOS once covers are live everywhere.

### The field merge, staging first

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

### Before merging 17 and 18 in production

- [ ] **BEFORE merging 17 and 18 in production (Ryan), READ ONLY: list everything tied to them and decide each one.**
  - Read with the production preview (`GET /admin/fields/17/merge-into/10/preview` and `/18/merge-into/12/preview`,
    which write nothing) or a read-only query.
  - **Promo codes** restricted to 17 or 18. The merge never changes a code: moved matches lose any code that is on the
    old field only, unless staff extend it to 10 or 12 first. The preview's `warnings` lists each one with the number
    of matches.
  - **Phone numbers** on 17 and 18. They are the cancellation-text numbers for that field; they stay on the hidden
    field.
  - **Special events** at 17 or 18 that have not started. Events do not move.
  - **Reminder settings:** is 17 or 18 in `PRE_MATCH_REMINDER_FIELD_IDS` on production while 10 or 12 is not? If so,
    moved matches lose the pre-match reminder.
  - Write the list and each decision here, with who decided, before the merge runs.

