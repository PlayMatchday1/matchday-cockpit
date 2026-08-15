-- 0124 — make the leaking combination UNREPRESENTABLE (Phase 29b)
--
-- THE BUG THIS CLOSES. The city-manager tier was ADDITIVE: an account held is_city_manager +
-- city_identifier AND the ordinary can_access_matchops. authenticateMatchOpsRead requires exactly
-- that flag and knew nothing about the tier, so a DFW city manager could open the entire Match Ops
-- estate — Master Schedule, Slate Review, Field Ops, Inventory, Change Log, and Player Lookup,
-- which is player PII for EVERY city. Observed live on a real account.
--
-- THREE LAYERS, and this is the third:
--   1. THE GATE (shipped, the guarantee) — isCityManagerConfined refuses a city manager at
--      authenticateAdmin and authenticateMatchOpsRead regardless of which can_* flags the row
--      carries. Nothing gets past it.
--   2. THE GRANT PATH (shipped, defence) — /api/admin/users/city-manager returns 409 rather than
--      granting the tier to an account still holding the broad flags.
--   3. THIS CONSTRAINT (defence) — the state cannot exist in the table at all. It matters because
--      layers 1 and 2 are code: a future gate that forgets to call isCityManagerConfined, or a
--      hand-run UPDATE, reopens the door. A CHECK does not forget.
--
-- ═══ ORDER: APPLY THIS ONE *AFTER* THE DEPLOY, NOT BEFORE ═══════════════════
--
-- This DELIBERATELY INVERTS the standing rule in CLAUDE.md ("Migrations land before the code that
-- depends on them"). That rule exists because code deploys before a migration can be run by hand,
-- so a named column that does not exist yet 500s every admin route. The reasoning does not apply
-- here, and the opposite one does:
--
--   THIS MIGRATION ENABLES NO CODE. It CREATES a failure mode — a check_violation — that
--   mapAppUsersConstraint (src/lib/appUsersConstraint.ts) exists to translate into a stated 409.
--
-- Apply it while production is still on the old build and any write touching a city manager
-- returns a RAW 500 with this constraint's name in the response body: the invite route upserts on
-- email, so inviting an EXISTING city manager is enough to hit it. The translation ships with the
-- code; the constraint must not arrive first.
--
--   1. deploy the code (mapAppUsersConstraint + the up-front refusals in invite/city-manager)
--   2. confirm the deploy is LIVE and serving that SHA
--   3. THEN apply this migration
--
-- ORDER within this file: the rows must already be clean or the ALTER fails. They were cleaned by
-- hand when the leak was found; step 1 below confirms before the ALTER runs.
--
-- Apply in the Supabase SQL editor.

-- 1) CONFIRM FIRST. This must return zero rows. If it does not, the constraint will fail — fix the
--    rows before adding it, do not weaken the constraint.
select id, email, is_city_manager, city_identifier,
       can_access_matchops, can_access_home, can_access_finance, can_access_growth,
       can_access_membership, can_access_chats, can_access_tech, can_access_org
  from app_users
 where is_city_manager = true
   and (can_access_matchops or can_access_home or can_access_finance or can_access_growth
        or can_access_membership or can_access_chats or can_access_tech or can_access_org
        or is_admin);

-- 2) THE CONSTRAINT. A city manager holds the tier and a scope, and NONE of the broad access
--    flags — their access is the /city/* pages, gated on is_city_manager + city_identifier.
--    NOT VALID is deliberately NOT used: we want it enforced against existing rows too, and step 1
--    has already proven there are none to break.
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
      and coalesce(can_access_membership, false) = false
      and coalesce(can_access_chats, false) = false
      and coalesce(can_access_tech, false) = false
      and coalesce(can_access_org, false) = false
    )
  );

comment on constraint app_users_city_manager_is_exclusive on app_users is
  'Phase 29b: the city-manager tier is RESTRICTIVE, not additive. Holding it alongside any broad '
  'can_access_* flag (or is_admin) is what let a city manager read every city''s data through the '
  'Match Ops gate. The gate now confines them regardless; this makes the state unrepresentable.';

-- ROLLBACK (only if this has to be removed — note that doing so makes the leaking state
-- representable again, and only the code gate stands between it and a repeat):
--   alter table app_users drop constraint app_users_city_manager_is_exclusive;
