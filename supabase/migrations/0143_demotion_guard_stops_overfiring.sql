-- 0143 — the scope cascade must fire on a DEMOTION, not on every write.
--
-- 0141 restored the term 0122 had dropped, and restored it in 0120's original form:
--
--     if NEW.is_city_manager = false then
--       NEW.city_identifier := null;
--     end if;
--
-- That has no OLD comparison and no TG_OP guard, and the trigger is BEFORE INSERT OR UPDATE. So it
-- fires on EVERY write to ANY row where is_city_manager is false — which is not "a demotion", it
-- is "a row that is not a city manager", and those are different sets. Two live consequences:
--
--   1. IT STRIPS THE TWO WARSAW ACCOUNTS. jf@playmatchday.pl and rgmstrategicventures@gmail.com
--      are the CONFINED tier: is_city_manager false WITH city_identifier 'WAW', legitimately. Any
--      write to either row — one checkbox on the User access screen — nulls the city. isConfined()
--      keys on city_identifier alone, so the account stops being confined and canAccess() then
--      hands it the whole Match Ops estate across every city.
--   2. IT MAKES A NEW CONFINED ACCOUNT UNCREATABLE. On INSERT the same branch runs before the row
--      lands, so the city is stripped on the way in and the tier cannot be provisioned at all.
--
-- THE FIX IS THE DEMOTION TEST ITSELF — was a city manager, is no longer:
--
--     if TG_OP = 'UPDATE' and OLD.is_city_manager = true and NEW.is_city_manager = false then
--
-- TG_OP IS CHECKED FIRST AND THAT IS LOAD-BEARING, not stylistic. In PL/pgSQL, OLD is unassigned
-- in an INSERT trigger and touching it raises "record old is not assigned yet". `and` short-
-- circuits left to right, so the TG_OP test is what stops the INSERT path ever reading OLD.
--
-- EVERYTHING ELSE IS CARRIED THROUGH VERBATIM from the live body read out of pg_proc — the
-- matchops cascade, all five service-account raises, and the can_edit_credits note. This file is
-- that text with one block replaced.
--
-- app_users_growth_guard() IS NOT TOUCHED. It is a separate function on its own trigger, put there
-- by 0140 precisely so that repairing this one cannot disturb it.
--
-- Apply in the Supabase SQL editor.

create or replace function public.app_users_edit_matches_guard()
returns trigger
language plpgsql
as $function$
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
  -- NARROWED (0143). This is the escalation-on-demotion fix, and it must fire ONLY on an actual
  -- demotion. 0141 restored 0120's unguarded form, which nulled the scope on every write to any
  -- non-manager row — stripping the CONFINED tier (is_city_manager false WITH a city, which is
  -- legitimate) and making a confined account uncreatable, because BEFORE INSERT ran it too.
  -- TG_OP first: OLD is unassigned on INSERT and reading it there raises.
  if TG_OP = 'UPDATE'
     and OLD.is_city_manager = true
     and NEW.is_city_manager = false then
    NEW.city_identifier := null;      -- demoted: no tier => no lingering scope
  end if;
  return NEW;
end $function$;

-- The trigger app_users_edit_matches_guard_trg (0114) already fires this function BEFORE INSERT OR
-- UPDATE. Replacing the body is enough; no new trigger, and app_users_growth_guard_trg is untouched.

-- ── VERDICT — ONE query, ONE row ─────────────────────────────────────────────────────────────
-- EVERY EXPECTED COUNT IS DERIVED FROM THE LIVE BODY READ OUT OF pg_proc, not from this file:
--   service_account_raises 5  — EDIT MATCHES, MANAGE PLAYERS, MANAGE PROMOS, EDIT CREDITS,
--                               CITY MANAGER. Same 5 that 0141's verdict returned.
--   matchops_cascade       1  — the can_access_matchops = false block survived
--   edit_credits_note      1  — the "INTENTIONALLY absent" comment survived
--   demotion_guard         1  — TG_OP = 'UPDATE' is now present
--   reads_old              1  — OLD.is_city_manager is now referenced; the pre-0143 body
--                               contained no OLD reference at all, so this is the proof the
--                               over-firing form is GONE and not merely accompanied
--   warsaw_waw             2  — both confined rows still hold 'WAW'. This migration performs no
--                               UPDATE; if this is not 2, something else moved them.
select
  (length(p.prosrc) - length(replace(p.prosrc, 'is_service_account = true', '')))
    / length('is_service_account = true')                                as service_account_raises,
  (p.prosrc like '%can_access_matchops = false%')::int                   as matchops_cascade,
  (p.prosrc like '%INTENTIONALLY absent%')::int                          as edit_credits_note,
  (p.prosrc like '%TG_OP = ''UPDATE''%')::int                            as demotion_guard,
  (p.prosrc like '%OLD.is_city_manager%')::int                           as reads_old,
  (select count(*) from app_users
    where email in ('jf@playmatchday.pl', 'rgmstrategicventures@gmail.com')
      and city_identifier = 'WAW')                                       as warsaw_waw
from pg_proc p
where p.proname = 'app_users_edit_matches_guard';

-- ROLLBACK: re-apply 0141's body verbatim. Doing so restores the over-firing cascade — the next
-- write to either Warsaw row would then strip its city.
