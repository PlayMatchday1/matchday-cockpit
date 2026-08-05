-- 0103: CONTRACT phase — drop the retired app_users permission columns.
--
-- Apply ONLY AFTER 0102 is applied AND the new code is deployed (which reads the
-- new per-tab columns). By then nothing reads clubhouse/cities/data/docs, so the
-- drop is safe. Atomic: if any dependency unexpectedly references one of these,
-- the whole txn rolls back and nothing changes (per the RLS audit, only
-- can_access_chats is referenced by policy, and it is NOT dropped here).
--
-- can_access_chats, can_access_finance, is_admin and can_access_org are untouched.

BEGIN;

ALTER TABLE app_users
  DROP COLUMN IF EXISTS can_access_clubhouse,
  DROP COLUMN IF EXISTS can_access_cities,
  DROP COLUMN IF EXISTS can_access_data,
  DROP COLUMN IF EXISTS can_access_docs;

COMMIT;
