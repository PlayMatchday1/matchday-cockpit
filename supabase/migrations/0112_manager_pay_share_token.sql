-- 0112: manager_pay_share_token — the single shareable read-only link for the
-- Manager Pay page.
--
-- ONE token for the whole page (single-row table, id fixed to 1). Stored only as
-- a SHA-256 hash, never plaintext — a DB leak cannot reveal a working link. An
-- admin rotates it (mints a new token, overwrites the hash), which instantly
-- invalidates the old link; rotated_by/rotated_at record who/when for the admin
-- view. The plaintext is shown once at rotation and never persisted.
--
-- ACCESS: RLS is enabled with NO authenticated policy, so neither anon nor
-- authenticated can read the hash — only the admin route (service role, after an
-- is_admin gate) writes/reads metadata, and the public shared endpoint validates
-- a candidate token with the service role. This table is deliberately unreadable
-- by the browser client.
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

create table if not exists manager_pay_share_token (
  id         smallint    primary key default 1 check (id = 1), -- exactly one row
  token_hash text        not null,
  rotated_by uuid        references app_users(id),
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table manager_pay_share_token enable row level security;
-- No policies on purpose: the hash is a secret. Service-role access (RLS-bypass,
-- server-only) is the only path; anon/authenticated get zero rows.
