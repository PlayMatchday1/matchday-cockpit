-- 0195 — EDIT MEMBERSHIPS. A SIXTH write permission, and the SECOND one that moves money:
-- it prices and ends a player's membership from Player Lookup.
--
-- ── WHY THIS IS THE can_edit_credits SHAPE AND NOT THE can_edit_matches SHAPE ────────────────
-- 0114 / 0116 / 0117 each carry a `..._requires_matchops` constraint, because editing a match,
-- banning a player and creating a promo are all things you do INSIDE Match Ops. Changing what a
-- member is charged is not one of those, for the same reason moving credit is not: nobody should
-- acquire the ability to re-price or cancel a live subscription as a side effect of being granted
-- Match Ops read.
--
-- So this column stands alone. It is NEITHER implied by can_access_matchops NOR cascaded off by
-- it, exactly as 0122 ruled for EDIT CREDITS. There is deliberately no constraint here and no line
-- in the cascade below — the omission is the design, not an oversight.
--
-- IT IS ALSO NOT TIED TO can_access_membership. That flag governs READING the Membership reports;
-- this one governs WRITING to a player's subscription from Player Lookup. Tying them would mean
-- granting the membership dashboards also handed out the ability to cancel a paying member, which
-- is the same mistake in a different direction.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────────────────────
-- It grants nothing by itself. No route reads it yet; see the note at the foot of this file about
-- ordering, which matters here more than usual.
--
-- Apply in the Supabase SQL editor.

-- 1) DEFAULT OFF for EVERY existing row, Ryan included. No backfill from any other grant.
alter table public.app_users
  add column if not exists can_edit_memberships boolean not null default false;

comment on column public.app_users.can_edit_memberships is
  'EDIT MEMBERSHIPS. Add, price and end a player membership from Player Lookup. Not implied by
   can_access_matchops and not cascaded off by it, same rule as can_edit_credits (0122).';

-- 2) Extend the shared before-trigger guard so a SERVICE ACCOUNT can never hold it.
--
--    THE WHOLE BODY IS RESTATED, because `create or replace function` replaces it wholesale and
--    anything omitted is deleted. This text is 0143's verbatim — the matchops cascade, the five
--    existing service-account raises, the city-manager raise and the narrowed demotion guard —
--    with ONE raise added. 0122 is the cautionary tale: it replaced the whole body and silently
--    dropped 0120's city-manager term, which 0141 then had to restore.
--
--    KEYED ON is_service_account, which 0116 set from EMAIL. 0114's full_name match was a no-op
--    and is why that rule is written down: the E2E row is clubhouse-e2e@playmatchday.com.
--
--    NOTE WHAT IS NOT ADDED: no matchops cascade line for can_edit_memberships — see the header.
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
    -- can_edit_memberships is INTENTIONALLY absent for the same reason (0195).
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
  -- ADDED (0195). The sixth raise.
  if NEW.can_edit_memberships = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold EDIT MEMBERSHIPS', NEW.email;
  end if;
  -- RESTORED (0141). Added by 0120, dropped by 0122's whole-body replacement.
  if NEW.is_city_manager = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot be a CITY MANAGER', NEW.email;
  end if;
  -- NARROWED (0143). Fires ONLY on an actual demotion. TG_OP first: OLD is unassigned on INSERT
  -- and reading it there raises.
  if TG_OP = 'UPDATE'
     and OLD.is_city_manager = true
     and NEW.is_city_manager = false then
    NEW.city_identifier := null;      -- demoted: no tier => no lingering scope
  end if;
  return NEW;
end $function$;

-- The trigger app_users_edit_matches_guard_trg (0114) already fires this function BEFORE INSERT OR
-- UPDATE. Replacing the body is enough; no new trigger, and app_users_growth_guard_trg is untouched.

-- 3) GRANT to Ryan only. The WHERE keys on the real holder's email and also satisfies
--    pg_safeupdate, which rejects an unqualified UPDATE.
update public.app_users set can_edit_memberships = true
  where email = 'rmancuso@playmatchday.com';

-- ── VERDICT — ONE query, ONE row ─────────────────────────────────────────────────────────────
--   service_account_raises 6  — was 5 before this migration (EDIT MATCHES, MANAGE PLAYERS,
--                               MANAGE PROMOS, EDIT CREDITS, CITY MANAGER); EDIT MEMBERSHIPS is
--                               the sixth. If this reads 5, the raise did not land; if it reads
--                               fewer, the replace dropped terms and 0143 must be re-applied.
--   matchops_cascade       1  — the can_access_matchops = false block survived
--   demotion_guard         1  — TG_OP = 'UPDATE' survived
--   reads_old              1  — OLD.is_city_manager survived, so 0143's narrowing is intact
--   city_manager_raise     1  — 0141's term survived this whole-body replace
--   holders                1  — granted to Ryan and nobody else
--   e2e_blocked            1  — the E2E row is still flagged a service account
--   warsaw_waw             2  — both confined rows still hold 'WAW'. This migration performs no
--                               UPDATE against them; if this is not 2, something else moved them.
select
  (length(p.prosrc) - length(replace(p.prosrc, 'is_service_account = true', '')))
    / length('is_service_account = true')                                as service_account_raises,
  (p.prosrc like '%can_access_matchops = false%')::int                   as matchops_cascade,
  (p.prosrc like '%TG_OP = ''UPDATE''%')::int                            as demotion_guard,
  (p.prosrc like '%OLD.is_city_manager%')::int                           as reads_old,
  (p.prosrc like '%cannot be a CITY MANAGER%')::int                      as city_manager_raise,
  (select count(*) from public.app_users where can_edit_memberships = true)  as holders,
  (select count(*) from public.app_users
    where email = 'clubhouse-e2e@playmatchday.com' and is_service_account = true) as e2e_blocked,
  (select count(*) from public.app_users
    where email in ('jf@playmatchday.pl', 'rgmstrategicventures@gmail.com')
      and city_identifier = 'WAW')                                       as warsaw_waw
from pg_proc p
where p.proname = 'app_users_edit_matches_guard';

-- P0001 PROOF — run this separately; it MUST raise
--   'Service account (clubhouse-e2e@playmatchday.com) cannot hold EDIT MEMBERSHIPS'.
-- If it succeeds instead, the guard did not take and the column must be revoked immediately.
--   update public.app_users set can_edit_memberships = true
--     where email = 'clubhouse-e2e@playmatchday.com';

-- PROOF that the right is NOT implied by Match Ops — must return 0:
--   select count(*) as matchops_without_memberships from public.app_users
--     where can_access_matchops = true and can_edit_memberships = true
--       and email <> 'rmancuso@playmatchday.com';

-- REVOKE (kill switch) — the WHERE is REQUIRED. This Supabase project runs pg_safeupdate, which
-- REJECTS an unqualified UPDATE. Do NOT "clean up" the WHERE.
--   update public.app_users set can_edit_memberships = false where can_edit_memberships = true;
--   -- or one user:
--   update public.app_users set can_edit_memberships = false
--     where email = 'rmancuso@playmatchday.com';

-- ── ORDERING, WHICH MATTERS MORE HERE THAN USUAL ────────────────────────────────────────────
-- THIS MIGRATION LANDS BEFORE THE CODE THAT READS THE COLUMN. adminAuth reads app_users with
-- select("*") deliberately and must never name a permission column: code deploys before a
-- migration is applied, and a named column that does not exist yet 500s every admin route. Adding
-- the column first is what keeps that true.
