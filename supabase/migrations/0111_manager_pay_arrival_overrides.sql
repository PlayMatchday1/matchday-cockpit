-- 0111: manager_pay_arrival_overrides — admin hand-set arrival date for a week.
--
-- The estimated ARRIVAL date (when payroll lands in managers' accounts) is
-- computed at render — pay-run Tuesday + 4 banking days (see src/lib/bankingDays.ts).
-- An admin may override it for a given week when reality diverges (a bank delay,
-- an off-cycle run). An override is never silent: it records WHO set it, WHEN, a
-- short REASON, and is visibly marked in the UI with a one-click reset back to the
-- computed value. Managers see the date and that it was adjusted; only admins write.
--
-- Week identifier = week_start, the Monday work-week start, exactly how the page
-- and manager_pay_adjustments (0025) key a week.
--
-- GRANTS: additive new table. RLS + the authenticated SELECT policy mirror
-- manager_pay_adjustments (0025) verbatim, which relies on Supabase's default
-- table privileges (authenticated SELECT). Writes go only through the admin route
-- with the service role (RLS-bypassing after an is_admin gate) — there is no
-- authenticated INSERT/UPDATE/DELETE policy, exactly like adjustments. Confirm
-- post-apply that authenticated SELECT works and anon does not (verify script).
--
-- Apply in the Supabase SQL Editor. Not applied by the app.

create table if not exists manager_pay_arrival_overrides (
  week_start   date        primary key,               -- Monday work-week start (the week id)
  arrival_date date        not null,                  -- the hand-set arrival date
  reason       text        not null,                  -- short, required reason
  set_by       uuid        not null references app_users(id),
  set_at       timestamptz not null default now(),    -- server-stamped
  created_at   timestamptz not null default now()
);

alter table manager_pay_arrival_overrides enable row level security;

drop policy if exists manager_pay_arrival_overrides_auth_select on manager_pay_arrival_overrides;
create policy manager_pay_arrival_overrides_auth_select
  on manager_pay_arrival_overrides for select to authenticated using (true);
