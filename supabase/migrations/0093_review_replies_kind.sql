-- 0093: review_replies — add an explicit "no reply needed" state + optional note.
--
-- Today a review_replies row means "replied". A blank (no row) means BOTH "not
-- done yet" and "deliberately nothing" — the two states we want to separate. Add
-- a `kind` so a row can record either resolved state, and a `note` for the reason
-- a review needs no reply (spam, no comment, handled elsewhere).
--
--   kind = 'replied'          → the existing green "Replied" mark.
--   kind = 'no_reply_needed'  → the new neutral "No reply needed" mark.
--   (no row)                  → still open; the only state that counts as owed.
--
-- One row per review is already enforced (review_id is the PK), so a double-click
-- cannot create a duplicate. replied_at stays a server default (never a browser
-- timestamp). RLS is unchanged — 0090 already opened SELECT/INSERT/DELETE to any
-- authenticated app_user, which is exactly who may set these states.
--
-- Existing rows default to 'replied', which is what they already mean, so no
-- backfill and no behaviour change for anything already ticked.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

alter table review_replies
  add column if not exists kind text not null default 'replied'
    check (kind in ('replied', 'no_reply_needed')),
  add column if not exists note text;
