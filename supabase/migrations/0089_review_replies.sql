-- 0089: review_replies — the "we answered this player" mark for the Reviews page.
--
-- Reviews come from the SYNCED side (mdapi_reviews, overwritten wholesale by the
-- mdapi-reviews sync), so the reply mark cannot be a column on the review — the
-- next sync would erase it. It lives here instead, referencing the review by its
-- natural key (mdapi_reviews.api_id). One mark per review → api_id is the PK.
--
-- No FK to mdapi_reviews on purpose: that table is truncated/rewritten by the
-- sync, and a FK would either block the sync or cascade-delete real reply marks.
-- The natural-key reference is intentional; an orphaned mark (review no longer
-- present) is surfaced by the app, not enforced away here.
--
-- RLS: readable by any authenticated admin; INSERT/DELETE gated on
-- app_users.is_admin, via the same email-claim idiom as 0080_city_community_links
-- and the other admin-mutating tables. No existing gate is relaxed.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

create table if not exists review_replies (
  review_id   bigint      primary key,           -- = mdapi_reviews.api_id (one mark per review)
  replied_at  timestamptz not null default now(),
  replied_by  uuid        not null references app_users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists review_replies_replied_by_idx on review_replies (replied_by);

-- updated_at maintenance (repo convention), harmless even though the app only
-- inserts/deletes rather than updates.
create or replace function review_replies_set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
drop trigger if exists review_replies_updated_at on review_replies;
create trigger review_replies_updated_at
  before update on review_replies
  for each row execute function review_replies_set_updated_at();

alter table review_replies enable row level security;

-- Admin can read the marks.
drop policy if exists review_replies_admin_select on review_replies;
create policy review_replies_admin_select
  on review_replies for select to authenticated
  using (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email') and app_users.is_admin = true));

-- Admin can tick (insert)…
drop policy if exists review_replies_admin_insert on review_replies;
create policy review_replies_admin_insert
  on review_replies for insert to authenticated
  with check (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email') and app_users.is_admin = true));

-- …and un-tick (delete).
drop policy if exists review_replies_admin_delete on review_replies;
create policy review_replies_admin_delete
  on review_replies for delete to authenticated
  using (exists (select 1 from app_users
    where lower(app_users.email) = lower(auth.jwt() ->> 'email') and app_users.is_admin = true));
