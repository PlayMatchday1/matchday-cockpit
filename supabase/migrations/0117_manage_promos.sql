-- Phase 18b — MANAGE PROMOS, a FOURTH Match-Ops write permission, same shape as 0114's
-- EDIT MATCHES and 0116's MANAGE PLAYERS. It gates the Promo Codes screen — creating promo
-- codes (POST /admin/promocodes) and, later, edit/delete. Creating a discount that applies
-- across the platform is its own authority, distinct from editing matches or banning players,
-- so it is its own column. Off by default for everyone, granted explicitly.

-- 1) DEFAULT OFF for EVERY existing row, Ryan included. No backfill from any other grant —
--    inheriting one would silently hand promo powers to people who never had them.
alter table app_users add column if not exists can_manage_promos boolean not null default false;

-- 2) MANAGE PROMOS requires MATCH OPS — a row can never hold manage-promos without read.
alter table app_users drop constraint if exists app_users_manage_promos_requires_matchops;
alter table app_users add constraint app_users_manage_promos_requires_matchops
  check (can_manage_promos = false or can_access_matchops = true);

-- 3) Extend the existing before-trigger guard (function from 0114, trigger already attached)
--    to cover MANAGE PROMOS too — one function, one source of truth. Enforced at the DB, so
--    even a direct client update cannot break it:
--      * revoking MATCH OPS cascades edit AND manage-players AND manage-promos off  (rule 2)
--      * a service account can never hold any of the three write grants             (rule 3)
--    The E2E service account (clubhouse-e2e@playmatchday.com) was flagged is_service_account
--    by 0116 (keyed on EMAIL, fixing 0114's full_name no-op), so this guard bites for it.
create or replace function app_users_edit_matches_guard() returns trigger
language plpgsql as $$
begin
  if NEW.can_access_matchops = false then
    NEW.can_edit_matches := false;    -- cascade: no read => no write
    NEW.can_manage_players := false;  -- cascade: no read => no manage-players
    NEW.can_manage_promos := false;   -- cascade: no read => no manage-promos
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
  return NEW;
end $$;
-- (trigger app_users_edit_matches_guard_trg already fires this function per 0114 —
--  replacing the function body is enough; no new trigger needed.)

-- 4) GRANT to Ryan only. The WHERE keys on the real holder's email; it also satisfies
--    pg_safeupdate (which rejects an unqualified UPDATE). Granting requires MATCH OPS already
--    held (the constraint above), which Ryan has.
update app_users set can_manage_promos = true
  where email = 'rmancuso@playmatchday.com';

-- Proof queries after applying:
--   -- must return 1 (granted to Ryan only):
--   select count(*) as promo_holders from app_users where can_manage_promos = true;
--   -- must return 1 (the E2E row is flagged a service account, from 0116):
--   select count(*) as e2e_service_acct from app_users
--     where email = 'clubhouse-e2e@playmatchday.com' and is_service_account = true;
--   -- must RAISE 'Service account (...) cannot hold MANAGE PROMOS' (the P0001 proof):
--   update app_users set can_manage_promos = true
--     where email = 'clubhouse-e2e@playmatchday.com';

-- REVOKE (kill switch) — the WHERE is REQUIRED. This Supabase project runs pg_safeupdate,
-- which REJECTS an unqualified UPDATE. `where can_manage_promos = true` both satisfies it and
-- touches only the rows that matter. Do NOT "clean up" the WHERE.
--   update app_users set can_manage_promos = false where can_manage_promos = true;
--   -- or one user:
--   update app_users set can_manage_promos = false where email = 'rmancuso@playmatchday.com';
