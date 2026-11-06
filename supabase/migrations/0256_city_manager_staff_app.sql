-- 0256 — CITY MANAGERS IN THE STAFF APP (Ryan, 2026-11-06).
--
-- WHAT CHANGES. app_users_city_manager_is_exclusive (0124, extended 0139) refused a city manager
-- every broad can_access_* flag. The "City manager" preset on Admin → User access gives them four of
-- them for the staff app: can_access_matchops, can_access_chats, can_access_lifecycle and
-- can_access_growth. This CHECK now allows exactly those four and still refuses is_admin and every
-- other page flag (home, finance, membership, tech, org).
--
-- WHY IT IS SAFE TO RELAX. Holding Match Ops used to open the whole estate to a city manager (Phase
-- 29b). The server now confines them twice over, independently of this CHECK:
--   * the desktop still refuses a city manager every capability whatever the row carries
--     (isCityManagerConfined); only a request the server marks as the staff app is exempt
--     (src/lib/staffAppForward.ts), and there they are an ordinary confined account;
--   * a confined account reaches only the allowlisted routes, and every read and write is scoped to
--     its city (src/lib/cityConfinement.ts, assertMatchInScope, crmScope.ts).
-- Chats is the one grant the desktop routes also honour (authenticateCrm has never refused a city
-- manager); there it is scoped to their city by thread city_code, the same as the Warsaw accounts.
--
-- Run in the Supabase SQL Editor. Nothing else in the schema changes; no row is updated.

begin;

alter table app_users drop constraint if exists app_users_city_manager_is_exclusive;

alter table app_users
  add constraint app_users_city_manager_is_exclusive
  check (
    is_city_manager is not true
    or (
      coalesce(is_admin, false) = false
      and coalesce(can_access_home, false) = false
      and coalesce(can_access_finance, false) = false
      and coalesce(can_access_membership, false) = false
      and coalesce(can_access_tech, false) = false
      and coalesce(can_access_org, false) = false
    )
  );

comment on constraint app_users_city_manager_is_exclusive on app_users is
  '0256: a city manager may hold Match Ops, Chats, Player Lifecycle and Growth (the staff app''s '
  'City manager preset, each confined to their city by the server) and nothing else broad: never '
  'is_admin, home, finance, membership, tech or org. Phase 29b''s estate-wide leak is closed in the '
  'gates (isCityManagerConfined outside the staff app, the city boundary inside it).';

commit;

-- Check after running (expect forbids_admin = 1, allows_matchops = 1):
select
  (pg_get_constraintdef(c.oid) like '%is_admin%')::int              as forbids_admin,
  (pg_get_constraintdef(c.oid) not like '%can_access_matchops%')::int as allows_matchops
from pg_constraint c
where c.conname = 'app_users_city_manager_is_exclusive';
