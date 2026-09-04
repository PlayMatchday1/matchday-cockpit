-- 0159 — Veo matcher: record HOW confidently each recording was read.
--
-- The matcher used to be a single bit: an exact title posted, anything else queued.
-- It now scores four things separately (which venue the title names, which day, which
-- kick-off, and whether the match's field is one the code names) and posts anything
-- scoring 45 or better. A post that was not a perfect read is FLAGGED.
--
-- Without these columns the flag exists only inside one request. Two recordings that
-- posted for very different reasons — 'PRUMC | Aug 4 | 6:00pm' (exact, 100) and
-- 'SCISS | Aug 20 | 8pm' (the code matched only by appearing inside the words
-- "Scissortail Park", 78) — are indistinguishable afterwards, which is precisely the
-- distinction a reviewer needs.
--
-- Nullable and defaulted throughout: every row written before this migration keeps its
-- meaning, and a null score reads as "posted before the matcher scored anything".

ALTER TABLE public.veo_recordings
  -- 0-100. 100 is a perfect read; 45 is the floor for posting at all.
  ADD COLUMN IF NOT EXISTS match_score  smallint,

  -- The four components and the tier each one was read at, e.g.
  --   {"total":78,"band":"flagged",
  --    "code":18,"codeTier":"label","date":30,"dateForm":"month",
  --    "time":20,"timeForm":"ampm","field":10,"fieldAgrees":true}
  -- Kept as the whole object rather than four columns because it is a record of a
  -- decision, read as a unit by the review page and never queried component-wise.
  ADD COLUMN IF NOT EXISTS score_parts  jsonb,

  -- True for a post in the 45-99 band: it went out, and something about the title was
  -- a guess. Not a status — a flagged recording is 'posted' like any other.
  ADD COLUMN IF NOT EXISTS flagged      boolean NOT NULL DEFAULT false;

-- The review page's one new question: "what went out that we were not sure about?"
CREATE INDEX IF NOT EXISTS veo_recordings_flagged_idx
  ON public.veo_recordings (received_at DESC)
  WHERE flagged;

COMMENT ON COLUMN public.veo_recordings.match_score IS
  'Four-part read confidence 0-100 (code 40 / date 30 / time 20 / field 10). 100 = nothing guessed; >= 45 posts; below 45 queues as low_confidence.';
COMMENT ON COLUMN public.veo_recordings.flagged IS
  'Posted, but not on a perfect read. See score_parts for which of the four was a guess.';

-- queue_reason gains two values. It has never carried a CHECK constraint and does not
-- gain one here; this is the record of the vocabulary, matching VeoQueueReason in
-- src/lib/veo.ts:
--   'low_confidence'    — a single clean match was found, but the title was read too
--                         loosely to send (score under 45).
--   'codes_unavailable' — the veo_codes read failed and the matcher fell back to the
--                         in-code constant. The fallback NAMES a code so the review UI
--                         can show one; it does not authorize a post, because the
--                         constant is a snapshot that can be months stale.
COMMENT ON COLUMN public.veo_recordings.queue_reason IS
  'Why it queued: unparseable_subject, unknown_code, unconfirmed_code, no_match, multiple_matches, field_mismatch, ambiguous_time, low_confidence, codes_unavailable, post_failed. Null once posted.';
