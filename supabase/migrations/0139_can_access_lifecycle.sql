-- 0139 — can_access_lifecycle: the Player Lifecycle tab's permission, under its own name.
--
-- WHY. The section has been called "Player Lifecycle" on screen for weeks while its route said
-- /growth and its permission said can_access_growth. A NEW top-level Growth tab is coming, and two
-- different things called growth — one of them wearing a different name in the UI — is how someone
-- reaches for can_access_growth to gate a Growth page and silently grants the Lifecycle reports
-- instead. This frees the name by giving the incumbent its real one.
--
-- ═══ APPLY THIS *BEFORE* THE CODE THAT READS IT ═══════════════════════════════════════════════
-- The standing rule, and it applies normally here: the deploy names can_access_lifecycle in
-- lifecycleAuth's select list, and a named column that does not exist yet 403s every Lifecycle API
-- call. (0124 inverted this rule for its own reasons; nothing here does.)
--
-- can_access_growth IS DELIBERATELY LEFT IN PLACE AND UNREAD. Dropping a column while the old build
-- may still be serving is how every admin route 500s. It becomes the NEW Growth tab's permission in
-- a later push, which resets it to false rather than dropping and recreating it.
--
-- Apply in the Supabase SQL editor.

begin;

-- 1) THE COLUMN. DEFAULT FALSE — nobody gains access from the schema change alone.
alter table app_users
  add column if not exists can_access_lifecycle boolean not null default false;

-- 2) THE BACKFILL. Everyone who could open the section keeps being able to open it. WHERE clause is
--    load-bearing twice over: it is the correctness of the backfill, and pg_safeupdate rejects an
--    unqualified UPDATE.
update app_users
   set can_access_lifecycle = true
 where can_access_growth = true;

-- 3) THE EXCLUSIVITY CONSTRAINT HAS TO LEARN THE NEW NAME.
--    0124 makes "city manager + any broad can_access_* flag" unrepresentable, and it enumerates the
--    flags by name. A new broad flag it does not know about is a HOLE in exactly the rule it exists
--    to enforce: a city manager could hold can_access_lifecycle and the CHECK would pass.
--    Dropped and re-added inside this transaction, so the state is never representable in between.
alter table app_users drop constraint if exists app_users_city_manager_is_exclusive;

alter table app_users
  add constraint app_users_city_manager_is_exclusive
  check (
    is_city_manager is not true
    or (
      coalesce(is_admin, false) = false
      and coalesce(can_access_matchops, false) = false
      and coalesce(can_access_home, false) = false
      and coalesce(can_access_finance, false) = false
      and coalesce(can_access_growth, false) = false
      and coalesce(can_access_lifecycle, false) = false
      and coalesce(can_access_membership, false) = false
      and coalesce(can_access_chats, false) = false
      and coalesce(can_access_tech, false) = false
      and coalesce(can_access_org, false) = false
    )
  );

comment on constraint app_users_city_manager_is_exclusive on app_users is
  'Phase 29b, extended 0139: the city-manager tier is RESTRICTIVE, not additive. Holding it '
  'alongside any broad can_access_* flag (or is_admin) is what let a city manager read every '
  'city''s data through the Match Ops gate. can_access_lifecycle is enumerated here for the same '
  'reason as the rest — a broad flag this CHECK does not name is a hole in it.';

commit;

-- 4) VERDICT — ONE query, ONE row, so the SQL editor cannot show you only the last result set.
--    Expected: had_growth = has_lifecycle, mismatched_rows = 0, city_manager_holders = 0.
--    A backfill that MISSED someone is a support ticket. One that GRANTED the right to someone who
--    did not hold it is an access change nobody asked for, and mismatched_rows catches both.
select
  count(*) filter (where can_access_growth    = true)                 as had_growth,
  count(*) filter (where can_access_lifecycle = true)                 as has_lifecycle,
  count(*) filter (where coalesce(can_access_growth, false)
                      <> coalesce(can_access_lifecycle, false))       as mismatched_rows,
  count(*) filter (where is_city_manager = true
                     and can_access_lifecycle = true)                 as city_manager_holders,
  count(*)                                                            as total_accounts
from app_users;

-- ROLLBACK (before any code reads the column; afterwards it locks everyone out of the section):
--   begin;
--   alter table app_users drop constraint if exists app_users_city_manager_is_exclusive;
--   alter table app_users drop column if exists can_access_lifecycle;
--   -- then re-add 0124's constraint verbatim, WITHOUT the can_access_lifecycle term.
--   commit;
