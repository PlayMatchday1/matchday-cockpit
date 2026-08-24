-- 0141 — restore the two city-manager terms 0122 dropped from app_users_edit_matches_guard().
--
-- WHAT HAPPENED. Six migrations have extended that function by REPLACING ITS WHOLE BODY: 0114
-- created it, then 0116, 0117, 0118, 0120 and 0122 each rewrote it. 0120 added two terms; 0122's
-- rewrite does not contain them. Confirmed against the live database by reading prosrc, not by
-- reading these files.
--
-- WHAT WAS LOST:
--   * raise 'Service account (%) cannot be a CITY MANAGER'
--   * the `is_city_manager = false => city_identifier := null` cascade
--
-- THE SECOND ONE IS AN ESCALATION ON DEMOTION, not a lost belt-and-braces. isConfined()
-- (cityConfinement.ts:58) keys on city_identifier ALONE — it never looks at is_city_manager. So a
-- scope left behind by a demotion keeps the row CONFINED, and canAccess() (useAuth.ts:163) returns
-- TRUE for matchops and chats for any confined row WITHOUT READING EITHER COLUMN:
--
--     if (isConfined(appUser)) return page === "matchops" || page === "chats";
--
-- A city manager holds NO broad flags — constraint app_users_city_manager_is_exclusive (0124)
-- makes that unrepresentable — so demoting one leaves can_access_matchops and can_access_chats
-- both false, and the demoted account is nevertheless offered Match Ops and Chats, including Match
-- Chats and Player Chats, which it did not have as a city manager.
--
-- MEASURED BOUND ON THE BLAST RADIUS: it stops at the CHROME. Every server gate reads the column —
-- matchOpsAuth (can_access_matchops), crmAuth (can_access_chats), /api/reviews and capabilityAuth
-- (both via the pure can(), which unblocks on confinement but still requires the flag). A demoted
-- city manager sees the tab, the rail and the page shell, and every request behind them 403s. That
-- is a real defect — the rail must not offer a door the server will slam, which useAuth's own
-- comment says — and it is not data exposure.
--
-- ═══ THIS MIGRATION CONTAINS NO UPDATE, AND THAT IS DELIBERATE ════════════════════════════════
--
-- A TRIGGER ONLY FIRES ON A WRITE. Restoring the cascade prevents the NEXT stale scope; it does
-- not clean a row that is already stale, and nothing here touches existing rows. Ryan wants
-- rgmstrategicventures@gmail.com exactly as it is.
--
-- THE POPULATION, measured 2026-08-23: TWO accounts carry city_identifier with is_city_manager
-- false — rgmstrategicventures and jf, both WAW. NEITHER is a demoted city manager: both are the
-- Warsaw CONFINED tier, created that way on purpose, and both hold can_access_matchops and
-- can_access_chats deliberately. So the escalation is LATENT, not live: zero rows today reached
-- their state by demotion. It arms the moment any of the four current city managers — ATX, DFW,
-- HOU, SATX — is demoted.
--
-- ═══ AND THE LESSON, WHICH IS WHY 0140 DID NOT DO THIS ════════════════════════════════════════
--   Replacing a function body you cannot read is how a guard disappears.
--   Adding a separate function is how you avoid needing to read it.
-- 0140 needed a service-account block for can_access_growth and added app_users_growth_guard() as
-- its OWN function with its OWN trigger rather than extending this one — which is why that block
-- is intact, and why this file has one function to repair instead of two.
--
-- ═══ BEFORE YOU RUN IT ════════════════════════════════════════════════════════════════════════
-- The body below is the live body plus two blocks. DIFF IT FIRST:
--   select prosrc from pg_proc where proname = 'app_users_edit_matches_guard';
-- Everything above the first `-- RESTORED (0141)` marker must match what that returns, verbatim.
-- If it does not, STOP: something else has replaced the body since it was read, and running this
-- would delete that too — which is the exact failure this migration exists to repair.
--
-- Apply in the Supabase SQL editor.

create or replace function app_users_edit_matches_guard() returns trigger
language plpgsql as $$
begin
  if NEW.can_access_matchops = false then
    NEW.can_edit_matches := false;    -- cascade: no read => no write
    NEW.can_manage_players := false;  -- cascade: no read => no manage-players
    NEW.can_manage_promos := false;   -- cascade: no read => no manage-promos
    -- can_edit_credits is INTENTIONALLY absent: it is not a Match Ops power and does not
    -- follow Match Ops in either direction.
  end if;
  if NEW.can_edit_matches = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold EDIT MATCHES', NEW.email;
  end if;
  if NEW.can_manage_players = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold MANAGE PLAYERS', NEW.email;
  end if;
  if NEW.can_manage_promos = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold MANAGE PROMOS', NEW.email;
  end if;
  if NEW.can_edit_credits = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold EDIT CREDITS', NEW.email;
  end if;
  -- RESTORED (0141). Added by 0120, dropped by 0122's whole-body replacement.
  if NEW.is_city_manager = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot be a CITY MANAGER', NEW.email;
  end if;
  -- RESTORED (0141). THIS IS THE ESCALATION-ON-DEMOTION FIX. isConfined() keys on
  -- city_identifier ALONE, so a city_identifier left behind by a demotion keeps the row
  -- CONFINED — and canAccess() grants a confined row matchops and chats without reading
  -- either column.
  if NEW.is_city_manager = false then
    NEW.city_identifier := null;      -- cascade: no tier => no lingering scope
  end if;
  return NEW;
end $$;

-- The trigger app_users_edit_matches_guard_trg (0114) already fires this function BEFORE INSERT OR
-- UPDATE. Replacing the body is enough; no new trigger.

-- ── VERDICT — ONE QUERY, ONE ROW ─────────────────────────────────────────────────────────────
-- APPLIED 2026-08-23. Returned: 5 | 1 | 1 | 1 | 1 | 2 — all six as expected.
--
-- TWO MISTAKES THIS FILE ORIGINALLY MADE, both fixed here rather than left for the next reader:
--
--   1. IT ASKED TWO SEPARATE SELECTS. The Supabase SQL editor shows only the LAST result set, so
--      running it returned `stale_scopes` alone and said nothing about whether the function body
--      took. 0140 carries a comment warning about exactly this; this file then did it anyway.
--
--   2. IT EXPECTED service_account_terms = 6. THE ANSWER IS 5. The expectation came from counting
--      the literal with `grep -c` over this whole FILE, which also matched the copy of it inside
--      the verdict query below. The BODY has five: EDIT MATCHES, MANAGE PLAYERS, MANAGE PROMOS,
--      EDIT CREDITS (the four that were live) plus the restored CITY MANAGER. A verdict whose
--      expected value is derived from the file rather than from the thing being counted is not a
--      verdict.
--
-- edit_credits_note and matchops_cascade are NOT decoration. This migration exists because a
-- create-or-replace silently dropped two terms; those two columns prove that THIS replacement
-- dropped nothing in turn.
select
  (length(p.prosrc) - length(replace(p.prosrc, 'is_service_account = true', '')))
    / length('is_service_account = true')                                   as service_account_terms,  -- expect 5
  (p.prosrc like '%cannot be a CITY MANAGER%')::int                         as city_manager_raise,     -- expect 1
  (p.prosrc like '%city_identifier := null%')::int                          as scope_cascade,          -- expect 1
  (p.prosrc like '%INTENTIONALLY absent%')::int                             as edit_credits_note,      -- expect 1
  (p.prosrc like '%can_access_matchops = false%')::int                      as matchops_cascade,       -- expect 1
  (select count(*) from app_users
     where is_city_manager is not true
       and city_identifier is not null
       and length(btrim(city_identifier)) > 0)                              as stale_scopes            -- expect 2
-- ^ THE NAME IS WRONG AND THE NUMBER IS RIGHT. "stale_scopes" reads as "should be zero"; these two
-- rows are the CONFINED tier, which is legitimately is_city_manager=false WITH a city. Read it as
-- confined_non_managers. Nulling their city is the escalation 0143 exists to prevent.
from pg_proc p
where p.proname = 'app_users_edit_matches_guard';

-- ── TEETH (run each; both MUST raise, and neither may be left applied) ────────────────────────
-- a) must RAISE 'Service account (...) cannot be a CITY MANAGER':
--   update app_users set is_city_manager = true, city_identifier = 'ATX'
--     where email = 'clubhouse-e2e@playmatchday.com';
--
-- b) THE CASCADE, proven on a row that is ALREADY false — the write is a no-op to the tier and
--    must still null the scope. Run it against a THROWAWAY row, never a real account:
--   -- (no throwaway row exists today; skip unless one is created for the purpose)
--
-- ── REVOKE / ROLLBACK ────────────────────────────────────────────────────────────────────────
-- Re-apply 0122's body verbatim. Doing so re-opens the escalation described above.
