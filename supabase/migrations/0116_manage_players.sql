-- Phase 18 — MANAGE PLAYERS, a THIRD Match-Ops permission, same shape as 0114's
-- EDIT MATCHES. It will gate the account-level actions in Player Lookup — suspend /
-- expel / lift (PUT /admin/players/{id}/ban) — which are a different authority from
-- editing who is in a match (EDIT MATCHES). Banning someone from the platform and
-- moving them between teams should not travel together, so this is its own column.
--
-- Nothing in the app enforces MANAGE PLAYERS until the ban actions are wired — this
-- migration only lands the column, the constraint and the guard so the grant path and
-- the E2E service-account guard exist first (server enforcement comes with the actions).

-- 1) DEFAULT OFF for EVERY existing row, Ryan included. No backfill from
--    can_access_matchops or can_edit_matches — inheriting either would silently hand
--    ban powers to people who never had them and defeat the phase.
alter table app_users add column if not exists can_manage_players boolean not null default false;

-- 2) Repair + reassert the service-account marker, keyed on EMAIL not full_name.
--    0114 ran `update ... where full_name = 'Clubhouse E2E'`, but the row is actually
--    named 'Clubhouse E2E (read-only)', so that UPDATE matched ZERO rows. Email is the
--    stable identity. This sets is_service_account on the real E2E row (fixing 0114's
--    no-op) so the guard below can bite. is_service_account already exists (added 0114).
update app_users set is_service_account = true
  where email = 'clubhouse-e2e@playmatchday.com';

-- 3) MANAGE PLAYERS requires MATCH OPS — a row can never hold manage without read.
alter table app_users drop constraint if exists app_users_manage_requires_matchops;
alter table app_users add constraint app_users_manage_requires_matchops
  check (can_manage_players = false or can_access_matchops = true);

-- 4) Extend the existing before-trigger guard to cover MANAGE PLAYERS too (one function,
--    one source of truth — the trigger app_users_edit_matches_guard_trg from 0114 already
--    calls this). Enforced at the DB, so even a direct client update cannot break it:
--      * revoking MATCH OPS cascades BOTH edit and manage off  (rule 2)
--      * a service account can never hold edit OR manage        (rule 3)
create or replace function app_users_edit_matches_guard() returns trigger
language plpgsql as $$
begin
  if NEW.can_access_matchops = false then
    NEW.can_edit_matches := false;    -- cascade: no read => no write
    NEW.can_manage_players := false;  -- cascade: no read => no manage
  end if;
  if NEW.can_edit_matches = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold EDIT MATCHES', NEW.email;
  end if;
  if NEW.can_manage_players = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold MANAGE PLAYERS', NEW.email;
  end if;
  return NEW;
end $$;

-- (trigger app_users_edit_matches_guard_trg already fires this function per 0114 —
--  replacing the function body is enough; no new trigger needed.)

-- Proof queries after applying:
--   -- must return 0 (granted to no one):
--   select count(*) as manage_holders from app_users where can_manage_players = true;
--   -- must return 1 (the E2E row is now correctly flagged, fixing 0114):
--   select count(*) as e2e_service_acct from app_users
--     where email = 'clubhouse-e2e@playmatchday.com' and is_service_account = true;
--   -- must RAISE 'Service account (...) cannot hold MANAGE PLAYERS':
--   update app_users set can_manage_players = true
--     where email = 'clubhouse-e2e@playmatchday.com';
