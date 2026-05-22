-- Add can_access_chats permission to app_users so Chats can be its
-- own permission column in the Admin User Access matrix. Lets a
-- customer-service person be granted chat-only access without
-- granting is_admin or any other can_access_* flag.
--
-- Backfill is_admin = true users to can_access_chats = true so:
--   1. Admins keep current Chats access.
--   2. The Admin User Access matrix shows the Chats checkbox lit
--      for admins (matches the implicit shortcut in
--      src/lib/useAuth.ts:canAccess where is_admin → true).
--
-- Default false for non-admin users matches the pattern of every
-- other can_access_* column (Clubhouse is the lone exception there;
-- Chats follows the conservative default).
--
-- Apply via Supabase Dashboard → SQL Editor.

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS can_access_chats boolean NOT NULL DEFAULT false;

UPDATE app_users
  SET can_access_chats = true
  WHERE is_admin = true;
