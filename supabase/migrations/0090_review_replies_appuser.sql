-- 0090: review_replies — let any authenticated app_user mark a review replied.
--
-- Marking a player review "answered" is city-manager ops work, not a finance or
-- admin mutation. 0089 gated SELECT/INSERT/DELETE on app_users.is_admin, so a
-- non-admin city manager (e.g. Deonna Garcia, is_admin = false) got a silent
-- RLS denial (42501). This migration drops the is_admin condition for THIS ONE
-- table's three policies and nothing else.
--
-- Still enforced: the actor must be a real app_user — the JWT email must match a
-- row in app_users; anonymous or unknown JWTs remain denied. replied_by still
-- references app_users(id), so every mark still names a real person. SELECT is
-- opened too (not only INSERT/DELETE): the app re-reads after each write, so a
-- writer who couldn't read would see the tick vanish on reload.
--
-- No other admin gate is touched. Every other table keeps its is_admin RLS.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

-- Read: any app_user (was admin-only).
drop policy if exists review_replies_admin_select on review_replies;
drop policy if exists review_replies_appuser_select on review_replies;
create policy review_replies_appuser_select
  on review_replies for select to authenticated
  using (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email')));

-- Tick (insert): any app_user (was admin-only).
drop policy if exists review_replies_admin_insert on review_replies;
drop policy if exists review_replies_appuser_insert on review_replies;
create policy review_replies_appuser_insert
  on review_replies for insert to authenticated
  with check (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email')));

-- Un-tick (delete): any app_user (was admin-only).
drop policy if exists review_replies_admin_delete on review_replies;
drop policy if exists review_replies_appuser_delete on review_replies;
create policy review_replies_appuser_delete
  on review_replies for delete to authenticated
  using (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email')));
