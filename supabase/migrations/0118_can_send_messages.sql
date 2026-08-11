-- Phase 19 Step 1 — SEND MESSAGES. Splits the send right out of the read right for Player
-- Chats. Today `is_admin OR can_access_chats` covers BOTH reading a player's conversation and
-- MESSAGING them. Reading and sending are different rights and one of them is irreversible — a
-- message the player sees. Same shape as 0114 EDIT MATCHES / 0116 MANAGE PLAYERS / 0117 MANAGE
-- PROMOS. Off by default for everyone, granted explicitly. can_access_chats keeps meaning READ.

-- 1) DEFAULT OFF for every existing row, Ryan included. NO backfill from can_access_chats or
--    is_admin — inheriting either would silently hand send powers to every current reader.
alter table app_users add column if not exists can_send_messages boolean not null default false;

-- 2) SEND requires READ — can_send_messages can never be held without can_access_chats. (Ryan
--    already holds can_access_chats = true, so the grant in step 4 satisfies this.)
alter table app_users drop constraint if exists app_users_send_messages_requires_chats;
alter table app_users add constraint app_users_send_messages_requires_chats
  check (can_send_messages = false or can_access_chats = true);

-- 3) Extend the existing before-trigger guard (function from 0114, trigger already attached) to
--    cover SEND MESSAGES too — one function, one source of truth, enforced at the DB so even a
--    direct client update cannot break it:
--      * revoking CHATS access cascades send off
--      * a service account can never hold send. The E2E account (clubhouse-e2e@playmatchday.com)
--        was flagged is_service_account by 0116 (keyed on EMAIL, fixing 0114's full_name no-op)
--        and CAN read chats (can_access_chats = true) — so this guard is what blocks it sending.
create or replace function app_users_edit_matches_guard() returns trigger
language plpgsql as $$
begin
  if NEW.can_access_matchops = false then
    NEW.can_edit_matches := false;    -- cascade: no read => no write
    NEW.can_manage_players := false;  -- cascade: no read => no manage-players
    NEW.can_manage_promos := false;   -- cascade: no read => no manage-promos
  end if;
  if NEW.can_access_chats = false then
    NEW.can_send_messages := false;   -- cascade: no chats read => no send
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
  if NEW.can_send_messages = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold SEND MESSAGES', NEW.email;
  end if;
  return NEW;
end $$;
-- (trigger app_users_edit_matches_guard_trg already fires this per 0114 — replacing the
--  function body is enough; no new trigger needed.)

-- 4) GRANT to Ryan only. The WHERE keys on the real holder's email and satisfies pg_safeupdate.
update app_users set can_send_messages = true
  where email = 'rmancuso@playmatchday.com';

-- Proof queries after applying:
--   -- must return 1 (granted to Ryan only):
--   select count(*) as send_holders from app_users where can_send_messages = true;
--   -- must return 1 (the E2E row is a service account that CAN read chats):
--   select count(*) as e2e_service from app_users
--     where email = 'clubhouse-e2e@playmatchday.com' and is_service_account = true and can_access_chats = true;
--   -- must RAISE 'Service account (...) cannot hold SEND MESSAGES' (the P0001 proof):
--   update app_users set can_send_messages = true
--     where email = 'clubhouse-e2e@playmatchday.com';

-- REVOKE (kill switch) — the WHERE is REQUIRED (pg_safeupdate rejects an unqualified UPDATE):
--   update app_users set can_send_messages = false where can_send_messages = true;
--   -- or one user:
--   update app_users set can_send_messages = false where email = 'rmancuso@playmatchday.com';
