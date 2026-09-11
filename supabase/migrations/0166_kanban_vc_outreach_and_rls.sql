-- 0166 — VC OUTREACH BOARD, AND THE RLS THAT HAS TO LAND WITH IT.
--
-- ══ WHY THE POLICY IS HERE AND NOT IN A LATER PASS ═══════════════════════════════════════════
-- 0066 shipped kanban_cards with:
--     CREATE POLICY kanban_cards_rw ON kanban_cards FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Every signed-in account can read and write every card on every board. can_access_growth is a UI
-- gate; the browser holds a Supabase client with the user's JWT and can query PostgREST directly.
--
-- That is tolerable for venues we are chasing and engineering tasks. It is NOT tolerable for 90 VC
-- firms carrying target round, check sizes, named partners and commentary like "HOLD FOR SERIES A".
-- Loading that data under this policy would make MatchDay's fundraising position readable by every
-- city manager — not through the page, which refuses them, but straight off the table.
--
-- ══ auth.uid() IS THE WRONG KEY, AND THIS IS MEASURED ════════════════════════════════════════
-- The obvious policy is `EXISTS (SELECT 1 FROM app_users u WHERE u.id = auth.uid() AND ...)`.
-- IT WOULD MATCH ALMOST NOBODY. app_users.id is NOT the auth user id: checked 2026-09-11 against
-- auth.users, 16 of 17 app_users rows have an id that differs from their auth id; exactly one
-- coincides. adminAuth.ts already knows this — it looks the row up with
-- `.ilike("email", email)`, never by id.
--
-- So a uid-keyed policy would return zero rows for 16 of 17 accounts and turn Field Pipeline and
-- Tech Roadmap into empty boards that look like working pages with no data. THE JOIN IS ON EMAIL,
-- lower-cased on both sides, out of the JWT.
--
-- ══ THE CAPABILITY MODEL, MIRRORED FROM capabilities.can() ═══════════════════════════════════
--   · confinement BEATS is_admin. canAccess() short-circuits a confined account to matchops/chats
--     only, so a city manager carrying is_admin still gets nothing here. city_identifier non-empty
--     is what "confined" means (cityConfinement.isConfined).
--   · service accounts are refused outright, as can() refuses them.
--   · is_admin is sufficient for PAGE access, which is what these boards are.
--   · vc_outreach and field_pipeline need growth; tech_roadmap needs tech.
--
-- WRITES USE THE SAME PREDICATE. A reader who cannot see a card must not be able to write one, and
-- WITH CHECK governs the row as it will be after the write — so the board_type in the CHECK is the
-- new one, which is what stops someone moving a card between boards to escape the gate.
--
-- ══ WHAT BREAKS IF THIS IS WRONG ════════════════════════════════════════════════════════════
-- A policy that matches nothing does not error. Both existing boards render, with zero cards, and
-- look like a quiet week. VERIFY AFTER APPLYING: open /growth/field-pipeline and /tech/tech-roadmap
-- as an admin and confirm the card counts are unchanged, before importing anything.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

begin;

-- 1. The board type and its stages. Both CHECKs are REPLACED, not added to.
ALTER TABLE public.kanban_cards DROP CONSTRAINT IF EXISTS kanban_cards_board_type_check;
ALTER TABLE public.kanban_cards
  ADD CONSTRAINT kanban_cards_board_type_check
  CHECK (board_type IN ('field_pipeline','tech_roadmap','vc_outreach'));

ALTER TABLE public.kanban_cards DROP CONSTRAINT IF EXISTS kanban_cards_stage_valid;
ALTER TABLE public.kanban_cards
  ADD CONSTRAINT kanban_cards_stage_valid CHECK (
    (board_type = 'field_pipeline'
      AND stage IN ('backlog','contacted','negotiation','confirmed','archived'))
    OR (board_type = 'tech_roadmap'
      AND stage IN ('ideas','in_plan','in_progress','shipped'))
    OR (board_type = 'vc_outreach'
      AND stage IN ('not_contacted','outreach_sent','reply_needed','engaged',
                    'first_meeting','second_scheduling','second_scheduled'))
  );

-- 2. The policy. One predicate, used for USING and WITH CHECK.
CREATE OR REPLACE FUNCTION public.kanban_board_readable(p_board_type text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER                 -- reads app_users, which authenticated cannot select freely
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_users u
    WHERE lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      -- CONFINEMENT BEATS EVERY FLAG, is_admin included. Mirrors canAccess().
      AND coalesce(u.city_identifier, '') = ''
      AND coalesce(u.is_service_account, false) = false
      AND CASE p_board_type
            WHEN 'tech_roadmap' THEN (u.is_admin OR u.can_access_tech)
            ELSE (u.is_admin OR u.can_access_growth)
          END
  );
$$;

REVOKE ALL ON FUNCTION public.kanban_board_readable(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.kanban_board_readable(text) TO authenticated, service_role;

DROP POLICY IF EXISTS kanban_cards_rw ON public.kanban_cards;
CREATE POLICY kanban_cards_rw ON public.kanban_cards
  FOR ALL TO authenticated
  USING      (public.kanban_board_readable(board_type))
  WITH CHECK (public.kanban_board_readable(board_type));

-- The checklist rides on its card, so it inherits the card's gate rather than inventing one.
DROP POLICY IF EXISTS kanban_checklist_rw ON public.kanban_checklist_items;
CREATE POLICY kanban_checklist_rw ON public.kanban_checklist_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.kanban_cards c
                 WHERE c.id = kanban_checklist_items.card_id
                   AND public.kanban_board_readable(c.board_type)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.kanban_cards c
                 WHERE c.id = kanban_checklist_items.card_id
                   AND public.kanban_board_readable(c.board_type)));

DROP POLICY IF EXISTS kanban_audit_read ON public.kanban_audit_log;
CREATE POLICY kanban_audit_read ON public.kanban_audit_log
  FOR SELECT TO authenticated
  USING (public.kanban_board_readable(board_type));

commit;
