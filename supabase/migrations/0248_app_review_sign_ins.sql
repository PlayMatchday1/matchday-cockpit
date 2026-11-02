-- 0248: THE APP STORE REVIEW SIGN-IN LOG (Ryan, 2026-11-02).
--
-- One row for every attempt on the App Store review number (lib/reviewAccount.ts): a code asked
-- for (no text is ever sent to it), a sign-in, a wrong code, a lockout, or a refusal because the
-- review account is no longer the read-only Austin account it must be. The review route counts
-- wrong_code rows in the last hour to lock the number. Written and read by the service role only.

create table public.app_review_sign_ins (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  outcome text not null check (outcome in ('code_requested', 'signed_in', 'wrong_code', 'locked', 'account_unsafe')),
  ip text,
  user_agent text
);
create index app_review_sign_ins_outcome_at on public.app_review_sign_ins (outcome, at desc);
alter table public.app_review_sign_ins enable row level security;
-- No policies: RLS on with none means only the service role reads or writes it.
