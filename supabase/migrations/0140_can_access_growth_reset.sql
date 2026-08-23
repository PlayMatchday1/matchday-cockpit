-- 0140 — can_access_growth is REPURPOSED: it stops meaning Player Lifecycle and starts meaning the
-- new top-level Growth tab.
--
-- ═══ APPLY THIS *BEFORE* THE GROWTH-TAB CODE SHIPS ════════════════════════════════════════════
--
-- ═══ AND KNOW THIS BEFORE YOU RUN IT ══════════════════════════════════════════════════════════
--   AFTER THIS MIGRATION, NOBODY HOLDS can_access_growth — INCLUDING RYAN.
--   The Growth tab will be INVISIBLE to every account until it is granted.
--   ORDER:  1. run this        2. deploy the code        3. Ryan toggles HIMSELF on,
--   on the User access screen. There is no grant in this file, deliberately — see (3).
--
-- WHY A RESET AND NOT A DROP + RE-ADD. 0139 renamed the Player Lifecycle permission to
-- can_access_lifecycle and left this column in place, unread, precisely so that no deploy could
-- ever race a missing column: code ships before a migration can be run by hand, and a named column
-- that does not exist 500s every admin route. Ten rows still carry the OLD meaning. This returns
-- them to the column's DEFAULT FALSE so the new gate cannot read a stale grant as a new one.

begin;

-- 1) THE RESET. The WHERE is load-bearing twice: it is the correctness of the reset, and
--    pg_safeupdate rejects an unqualified UPDATE on this project.
update app_users
   set can_access_growth = false
 where can_access_growth = true;

-- 2) THE E2E SERVICE ACCOUNT, BLOCKED AT THE DATABASE, KEYED ON EMAIL.
--
--    is_service_account is set on clubhouse-e2e@playmatchday.com BY EMAIL (0116, which fixed
--    0114's keying on full_name — that matched nothing and the guard was a no-op for months).
--    This guard tests that flag, so it is keyed on email through it.
--
--    A SEPARATE FUNCTION AND A SEPARATE TRIGGER, DELIBERATELY. The obvious move is to extend
--    app_users_edit_matches_guard() the way 0116, 0117, 0118, 0120 and 0122 each did. Do not:
--    that function has been REPLACED WHOLE six times, and the newest replacement (0122) omits two
--    terms the one before it (0120) added — the service-account-cannot-be-a-city-manager raise, and
--    the `is_city_manager = false => city_identifier := null` cascade. Its LIVE text therefore
--    cannot be derived from these files, and `create or replace` on a body you cannot read is how
--    a guard gets silently deleted by the migration that was meant to strengthen it.
--    A second BEFORE trigger cannot erase anything. See the diagnostic at the bottom of this file.
create or replace function app_users_growth_guard() returns trigger
language plpgsql as $$
begin
  if NEW.can_access_growth = true and NEW.is_service_account = true then
    raise exception 'Service account (%) cannot hold GROWTH', NEW.email;
  end if;
  return NEW;
end $$;

drop trigger if exists app_users_growth_guard_trg on app_users;
create trigger app_users_growth_guard_trg
  before insert or update on app_users
  for each row execute function app_users_growth_guard();

-- 3) GRANTED TO NOBODY. There is no UPDATE here on purpose. The tab ships closed and Ryan turns it
--    on for himself from the User access screen once the deploy is live — which also exercises the
--    toggle, so the first thing that proves the grant path works is the grant itself.

commit;

-- 4) VERDICT — ONE query, ONE row, so the SQL editor cannot show you only the last result set.
--    Expected: growth_holders = 0, lifecycle_holders = 10, e2e_flagged = 1.
--    lifecycle_holders is here as the CONTROL: it proves this file touched the right column. A
--    reset that had hit can_access_lifecycle instead would also show growth_holders = 0.
select
  count(*) filter (where can_access_growth    = true)                            as growth_holders,
  count(*) filter (where can_access_lifecycle = true)                            as lifecycle_holders,
  count(*) filter (where email = 'clubhouse-e2e@playmatchday.com'
                     and is_service_account = true)                              as e2e_flagged,
  count(*)                                                                       as total_accounts
from app_users;

-- 5) THE GUARD'S TEETH. This MUST raise 'Service account (...) cannot hold GROWTH'. If it returns
--    "Success. No rows returned" instead, the guard is NOT biting and the block is not real.
--   update app_users set can_access_growth = true
--     where email = 'clubhouse-e2e@playmatchday.com';

-- 6) REVOKE (kill switch) — the WHERE is REQUIRED; pg_safeupdate rejects an unqualified UPDATE.
--   -- everyone:
--   update app_users set can_access_growth = false where can_access_growth = true;
--   -- one account:
--   update app_users set can_access_growth = false where email = 'someone@playmatchday.com';

-- ── DIAGNOSTIC, UNRELATED TO THIS MIGRATION AND NOT FIXED BY IT ───────────────────────────────
-- 0122 replaced app_users_edit_matches_guard() with a body that does NOT contain 0120's two
-- city-manager terms. If 0122 was applied after 0120 — which its number implies — then today:
--   * a service account CAN be flagged is_city_manager (0120's raise is gone), and
--   * clearing is_city_manager does NOT clear city_identifier (0120's cascade is gone), so a stale
--     scope lingers — and isConfined() keys on city_identifier ALONE, so the account stays confined.
-- Both fail SAFE (over-restrictive, and can() refuses service accounts before any flag is read), so
-- this is a loss of defence in depth rather than an open door. Settle it by reading the live body:
--   select prosrc from pg_proc where proname = 'app_users_edit_matches_guard';
-- If 'CITY MANAGER' does not appear in the output, it is gone and wants its own migration.
