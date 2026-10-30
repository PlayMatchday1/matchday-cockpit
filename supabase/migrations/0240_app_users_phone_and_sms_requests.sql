-- 0240: staff app sign-in by text code (approved by Ryan 2026-10-29; applied by hand in the SQL Editor).
--
-- app_users.phone: the staff member's mobile, E.164, unique. The Send SMS hook (/api/auth/sms-hook)
-- texts a code only to a number on this column, so a number on two staff accounts is impossible.
-- app_sms_code_requests: one row per code request the hook sees, sent or refused, for the 5 an hour
-- limit and the 30 second resend cooldown. RLS on with no policies: only the service role reads it.

alter table public.app_users add column phone text;
alter table public.app_users add constraint app_users_phone_e164 check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$');
create unique index app_users_phone_key on public.app_users (phone) where phone is not null;

create table public.app_sms_code_requests (
  id bigint generated always as identity primary key,
  phone text not null,
  requested_at timestamptz not null default now()
);
create index app_sms_code_requests_phone_time on public.app_sms_code_requests (phone, requested_at desc);
alter table public.app_sms_code_requests enable row level security;
