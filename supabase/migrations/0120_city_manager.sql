-- Phase 25 Part A — CITY MANAGER: a THIRD account tier, deliberately not a reuse of the second.
--
-- WHY NOT can_access_matchops: that flag now opens twelve routes — gameday, player lookup, player
-- payments, promo reads, change log, the roster reads. Anything moved onto the Match Ops read gate
-- later would be inherited by city managers SILENTLY, with no migration and no review. A city
-- manager is a narrower thing than an operator, so it gets its own flag and its own gate
-- (src/lib/cityManagerAuth.ts), in the same shape as matchOpsAuth: deny by default, routes opened
-- ONE AT A TIME, an overlooked route stays CLOSED.
--
-- TWO COLUMNS, because app_users has no city and the tier is meaningless without one:
--   is_city_manager  — the tier marker. Off for every existing row.
--   city_identifier  — the SCOPE. The same value mdapi_matches.city_identifier carries, so the
--                      server can push `.eq("city_identifier", …)` into the query rather than
--                      filtering after the fact. Values in use over the last 8 weeks:
--                      ATL, ATX, DFW, HOU, OKC, SATX, STL.
--
-- NO VALUE ALLOWLIST ON city_identifier, on purpose. A CHECK listing today's seven abbreviations
-- would reject a new city the day it launches, and we have been bitten by exactly that shape before
-- (fin_sync_log's source allowlist silently swallowed writes for an unlisted value). The constraint
-- below enforces the thing that actually matters — a city manager always HAS a scope — and leaves
-- which cities exist to the data.

-- 1) DEFAULT OFF for every existing row. No backfill, no inheritance from any other grant.
alter table app_users add column if not exists is_city_manager boolean not null default false;
alter table app_users add column if not exists city_identifier text;

-- 2) A city manager MUST carry a scope. An account with the tier and no city would be a request
--    the server cannot scope, and "no city" must never read as "all cities".
alter table app_users drop constraint if exists app_users_city_manager_needs_city;
alter table app_users add constraint app_users_city_manager_needs_city
  check (is_city_manager = false or (city_identifier is not null and length(btrim(city_identifier)) > 0));

-- 3) Extend the existing before-trigger guard (function from 0114, trigger already attached) so the
--    DB enforces the tier rules even against a direct client update:
--      * a service account can NEVER be a city manager (the E2E row is flagged is_service_account
--        by 0116, keyed on EMAIL — so this bites for it)
--      * clearing the tier clears the scope, so a stale city can never linger on a normal account
--        and be picked up if the flag is ever re-set
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
  -- Phase 25 — the city-manager tier
  if NEW.is_city_manager = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot be a CITY MANAGER', NEW.email;
  end if;
  if NEW.is_city_manager = false then
    NEW.city_identifier := null;      -- cascade: no tier => no lingering scope
  end if;
  return NEW;
end $$;

-- 4) GRANTED TO NOBODY. Phase 25 explicitly does not create a real city-manager account yet — the
--    tier ships closed and an account is provisioned as a separate, deliberate act. There is no
--    UPDATE here on purpose.

-- Proof queries after applying:
--   -- must return the two new columns:
--   select column_name, data_type, column_default from information_schema.columns
--     where table_name = 'app_users' and column_name in ('is_city_manager','city_identifier');
--   -- must return 0 (nobody holds the tier yet):
--   select count(*) as city_managers from app_users where is_city_manager = true;
--   -- must RAISE 'new row ... violates check constraint' (tier with no scope):
--   update app_users set is_city_manager = true
--     where email = 'rmancuso@playmatchday.com';
--   -- must RAISE 'Service account (...) cannot be a CITY MANAGER':
--   update app_users set is_city_manager = true, city_identifier = 'ATX'
--     where email = 'clubhouse-e2e@playmatchday.com';

-- REVOKE (kill switch) — the WHERE is REQUIRED. This Supabase project runs pg_safeupdate, which
-- REJECTS an unqualified UPDATE. Clearing the flag also clears the scope via the trigger above.
--   update app_users set is_city_manager = false where is_city_manager = true;
--   -- or one user:
--   update app_users set is_city_manager = false where email = 'someone@playmatchday.com';
