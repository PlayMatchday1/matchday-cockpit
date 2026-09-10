-- VEO SLOT INTENT — a camera mark that carries forward to a recurring slot.
--
-- veo_intent is keyed match_api_id PRIMARY KEY. It cannot say "every Tuesday at NEMP, 7pm", and it
-- cannot cover a match that does not exist yet — which matters because copy-to-dates on Master
-- Schedule creates matches constantly. This table holds the recurring rule; veo_intent stays, and
-- a veo_intent row for a specific match OVERRIDES the pattern underneath it.
--
-- ── `field` IS THE RAW field_title, NOT canonicalVenueName. MEASURED 2026-09-10 ────────────────
-- The obvious key is the canonical venue name, because that is what the operator sees in the grid.
-- It is wrong. Counted over 10,146 live mirror rows: 82 distinct field_title collapse to 56
-- canonical names, and 118 of 775 (city|canonical|weekday|hhmm) keys cover more than one raw title.
-- Eleven of the twelve merged groups are event labels for one venue ("Tourney at Soccer Central"
-- vs "Soccer Central Complex") and are harmless. ONE IS NOT:
--
--     Westlake  <-  "Westlake HS Field 3"  |  "Westlake HS Field 1&2"
--
-- Two different pitches at one school, colliding on live keys ATX|Westlake|4|20:00 and |4|19:45.
-- A pattern on the canonical name would silently cover both, and under the invariant this table
-- serves — a match whose intent is on has the camera emoji in its MatchDay name — that means
-- writing a player-visible glyph onto matches at a pitch nobody marked.
--
-- The raw title costs nothing: veoSchedule.ts already carries it as `fieldRaw` on BOTH readers
-- (:149 and :271). Keying on it also keeps a recurring league at "Soccer Central Complex" from
-- marking a one-off "Tourney at Soccer Central" that lands on the same weekday and time.
--
-- ── hhmm IS WALL CLOCK, AS TEXT ────────────────────────────────────────────────────────────────
-- Never a timestamp. mdapi_matches.start_date carries a Z it does not mean, and a Date on either
-- side moves a late-evening match across midnight — veoSchedule.ts:194 documents the bug this
-- already caused. The pattern is compared as text against start_date's own characters.
--
-- ── NO FOREIGN KEY TO mdapi_matches ────────────────────────────────────────────────────────────
-- Same rule 0100_veo_intent.sql states: mdapi_matches is a read-only mirror and a slot legitimately
-- describes matches that do not exist yet. That is the whole point of the table.
--
-- SERVICE ROLE ONLY, exactly like veo_intent and schedule_master. No anon, no authenticated: every
-- read and write goes through a route that has already authenticated and applied city confinement.

CREATE TABLE IF NOT EXISTS public.veo_slot_intent (
  city      text        NOT NULL,   -- mdapi_matches.city_identifier: ATX, HOU, SATX, DFW, STL, OKC
  field     text        NOT NULL,   -- mdapi_matches.field_title, RAW and exact. See the note above.
  weekday   smallint    NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday, JS getDay()
  hhmm      text        NOT NULL CHECK (hhmm ~ '^[0-2][0-9]:[0-5][0-9]$'),
  enabled   boolean     NOT NULL DEFAULT true,
  set_by    text,       -- 'clubhouse:pattern'. NOT 'seed:emoji' — that value is historical and
                        -- belongs to 0100's one-time backfill alone.
  set_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city, field, weekday, hhmm)
);

REVOKE ALL ON public.veo_slot_intent FROM anon, authenticated;
GRANT ALL ON public.veo_slot_intent TO service_role;
