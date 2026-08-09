-- Phase 17 — split Match Ops into READ (can_access_matchops, unchanged) and WRITE
-- (can_edit_matches, NEW). Lands BEFORE production MatchDay credentials go into Vercel.
--
-- can_edit_matches grants production writes across Gameday Ops, Master Schedule, the
-- match editor and the roster editor (all write the same match objects through the same
-- endpoints, so it is ONE permission, not four).

-- 1) DEFAULT OFF for every existing row. No backfill from can_access_matchops — that
--    would silently grant write access to all eight Match-Ops users and defeat the phase.
alter table app_users add column if not exists can_edit_matches boolean not null default false;

-- Service-account marker: the "Clubhouse E2E" smoke-test account must NEVER hold write.
alter table app_users add column if not exists is_service_account boolean not null default false;
update app_users set is_service_account = true where full_name = 'Clubhouse E2E';

-- 2) EDIT MATCHES requires MATCH OPS — a row can never hold write without read.
alter table app_users drop constraint if exists app_users_edit_requires_matchops;
alter table app_users add constraint app_users_edit_requires_matchops
  check (can_edit_matches = false or can_access_matchops = true);

-- Enforced at the DB, so even a direct client update cannot break the rules:
--   * revoking MATCH OPS revokes EDIT MATCHES atomically (rule 2, cascade)
--   * a service account can never be granted EDIT MATCHES (rule 3)
create or replace function app_users_edit_matches_guard() returns trigger
language plpgsql as $$
begin
  if NEW.can_access_matchops = false then
    NEW.can_edit_matches := false;                     -- cascade: no read => no write
  end if;
  if NEW.can_edit_matches = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold EDIT MATCHES', NEW.email;
  end if;
  return NEW;
end $$;

drop trigger if exists app_users_edit_matches_guard_trg on app_users;
create trigger app_users_edit_matches_guard_trg
  before insert or update on app_users
  for each row execute function app_users_edit_matches_guard();

-- Proof the migration granted it to NO ONE (must return 0):
--   select count(*) as edit_matches_holders from app_users where can_edit_matches = true;
