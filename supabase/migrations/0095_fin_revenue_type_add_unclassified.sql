-- The Stripe classifier now emits an 'Unclassified' type for charges that match
-- none of the four products (surfaced special_event_team / captain_division /
-- league charges that were previously mis-typed as Membership). fin_revenue_type_check
-- only permitted the original set, so commitStripe's insert failed — and because
-- the delete had already committed (no wrapping transaction), it emptied Dec 2025.
-- 'Private Rental' is already permitted; this adds 'Unclassified'. 'Other' is the
-- manual RevenueRowEditor option, kept so that path is unaffected.
--
-- Run the SELECT first to confirm the current definition, then the ALTER.

-- SELECT pg_get_constraintdef(oid) AS definition
-- FROM pg_constraint
-- WHERE conrelid = 'public.fin_revenue'::regclass AND conname = 'fin_revenue_type_check';

ALTER TABLE public.fin_revenue DROP CONSTRAINT fin_revenue_type_check;
ALTER TABLE public.fin_revenue ADD CONSTRAINT fin_revenue_type_check
  CHECK (type IN ('DPP', 'Membership', 'Strike', 'Private Rental', 'Other', 'Unclassified'));

-- Reverse (only after no 'Unclassified' rows remain, or the ADD will fail):
-- ALTER TABLE public.fin_revenue DROP CONSTRAINT fin_revenue_type_check;
-- ALTER TABLE public.fin_revenue ADD CONSTRAINT fin_revenue_type_check
--   CHECK (type IN ('DPP', 'Membership', 'Strike', 'Private Rental', 'Other'));
