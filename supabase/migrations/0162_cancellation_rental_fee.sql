-- 0162 — A CANCELLED DATE CAN STILL OWE THE RENTAL.
--
-- The signed PopStroke terms: a reservation cancelled with less than twelve hours' notice "MAY be
-- considered a completed reservation ... and/or MAY be subject to the applicable rental fee", and a
-- weather cancellation initiated by the venue incurs no fee. MAY, not shall — so whether MatchDay
-- charges itself, and at what notice, are DECISIONS. They live on the partner row beside every
-- other payout parameter, never as constants in the code.
--
-- WHAT WE CANNOT DERIVE, MEASURED BEFORE WRITING THIS: nothing we store records WHEN a match was
-- cancelled. mdapi_matches has is_cancelled, auto_canceled, auto_canceled_minutes, created_at,
-- updated_at and deleted_at, and no cancellation timestamp. On the Sep 5 PARMER match (api_id
-- 18321, kickoff 20:00) updated_at reads 22:50 — 2h50m AFTER kickoff — because the roster was
-- still being edited then; change_log shows the edits. Notice derived from updated_at would be a
-- negative number. Nothing records who cancelled or why either: no change_log row for 18321, 18185
-- or 18182 sets isCancelled, so none of them was cancelled through Cockpit.
--
-- Hence the second half: an explicit, per-match, auditable operator decision. The threshold column
-- is not decoration — the day a cancellation timestamp exists it starts deciding on its own, and
-- until then the override is the only thing that charges a cancellation. Nothing charges by
-- default: never bill a partner on a guess.

alter table public.partner_dashboards
  add column if not exists cancellation_fee_enabled boolean not null default false,
  add column if not exists cancellation_notice_hours integer not null default 12;

comment on column public.partner_dashboards.cancellation_fee_enabled is
  'Whether a short-notice cancellation is charged the field rental at all. The contract says MAY, so this is a decision, not a constant.';
comment on column public.partner_dashboards.cancellation_notice_hours is
  'Hours of notice below which the rental is owed. Consulted only when the notice is KNOWN; nothing records cancellation time today.';

alter table public.partner_dashboards
  add constraint partner_dashboards_cancellation_notice_hours_sane
  check (cancellation_notice_hours >= 0 and cancellation_notice_hours <= 720);

-- THE OPERATOR'S DECISION ON ONE CANCELLED MATCH. One row per (partner, match); rental_charged is
-- the whole decision and a reason is mandatory, because "weather" and "they cancelled the morning
-- of" are the two cases and neither is recoverable from the data afterwards.
-- partner_dashboards.id is a UUID (verified against the live row, not assumed from the migration
-- that created it) — so is partner_weekly_payments.partner_dashboard_id, which this mirrors.
create table if not exists public.partner_match_rental_overrides (
  id                    uuid primary key default gen_random_uuid(),
  partner_dashboard_id  uuid not null references public.partner_dashboards(id) on delete cascade,
  match_api_id          bigint not null,
  rental_charged        boolean not null,
  reason                text not null check (length(btrim(reason)) between 3 and 500),
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (partner_dashboard_id, match_api_id)
);

comment on table public.partner_match_rental_overrides is
  'Per-match operator decision on whether a cancelled date owes the field rental. rental_charged=false is the venue-initiated weather waiver, which never incurs the fee. Absent = not charged.';

alter table public.partner_match_rental_overrides enable row level security;
-- Service role only, like every other partner-payout table: the partner dashboards are public and
-- unauthenticated, and this decides what a venue is paid.
