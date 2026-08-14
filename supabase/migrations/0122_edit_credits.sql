-- Phase 27 — EDIT CREDITS. A FIFTH write permission, and the first one that MOVES MONEY:
-- it adjusts a player's credit balance (PUT /admin/players/{id}/profile {creditAmount}).
--
-- DELIBERATELY NOT TIED TO MATCH OPS. 0114 / 0116 / 0117 each carry a
-- `..._requires_matchops` constraint, because editing a match, banning a player and creating a
-- promo are all things you do INSIDE Match Ops. Moving money is not. Nobody should acquire the
-- ability to put $500 into an account as a side effect of being granted Match Ops read, so this
-- column stands alone: it is neither implied by can_access_matchops nor cascaded off by it.
-- That is why there is no constraint here and no line in the cascade below — the omission is the
-- design, not an oversight.

-- 1) DEFAULT OFF for EVERY existing row, Ryan included. No backfill from any other grant.
alter table app_users add column if not exists can_edit_credits boolean not null default false;

-- 2) Extend the shared before-trigger guard (function from 0114, trigger already attached) so a
--    SERVICE ACCOUNT can never hold it. Keyed on is_service_account, which 0116 set from EMAIL
--    (0114's full_name match was a no-op). Note what is NOT added: no matchops cascade — see above.
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
  return NEW;
end $$;
-- (trigger app_users_edit_matches_guard_trg already fires this function per 0114 —
--  replacing the function body is enough; no new trigger needed.)

-- 3) GRANT to Ryan only. The WHERE keys on the real holder's email and also satisfies
--    pg_safeupdate, which rejects an unqualified UPDATE.
update app_users set can_edit_credits = true
  where email = 'rmancuso@playmatchday.com';

-- Proof queries after applying:
--   -- must return 1 (granted to Ryan only):
--   select count(*) as credit_holders from app_users where can_edit_credits = true;
--   -- must return 1 (the E2E row is flagged a service account, from 0116):
--   select count(*) as e2e_service_acct from app_users
--     where email = 'clubhouse-e2e@playmatchday.com' and is_service_account = true;
--   -- must RAISE 'Service account (...) cannot hold EDIT CREDITS' (the P0001 proof):
--   update app_users set can_edit_credits = true
--     where email = 'clubhouse-e2e@playmatchday.com';
--   -- must return 0 — proves EDIT CREDITS is NOT implied by Match Ops:
--   select count(*) as matchops_without_credits from app_users
--     where can_access_matchops = true and can_edit_credits = true
--       and email <> 'rmancuso@playmatchday.com';

-- REVOKE (kill switch) — the WHERE is REQUIRED. This Supabase project runs pg_safeupdate,
-- which REJECTS an unqualified UPDATE. Do NOT "clean up" the WHERE.
--   update app_users set can_edit_credits = false where can_edit_credits = true;
--   -- or one user:
--   update app_users set can_edit_credits = false where email = 'rmancuso@playmatchday.com';
