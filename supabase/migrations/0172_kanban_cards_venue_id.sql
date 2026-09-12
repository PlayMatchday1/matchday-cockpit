-- 0172 — bind a Field Pipeline card to the fin_venues row it is about.
--
-- WHY A COLUMN AND NOT A NAME MATCH. A card titled "Crossbar Rowlett" in Confirmed and the
-- fin_venues row for Crossbar Rowlett are two unrelated records that happen to share a string.
-- Soccer Central has THREE fields whose names differ by a suffix; matching on the name turns them
-- into one venue or none. Nothing in FieldPipelineBoard.tsx or kanban.ts referenced fin_venues
-- before this, so the link has to be stored.
--
-- NULLABLE, AND THAT IS NOT A COMPROMISE. Every card sitting in Confirmed today has no venue: a
-- migration cannot invent the link, because deciding which fin_venues row a card means is a
-- judgement a person makes one card at a time. NOT NULL here would either fail on the existing
-- rows or force a fabricated link, which is the same bug with a database constraint over it.
--
-- IT IS MEANINGLESS ON THE VC BOARD. kanban_cards is shared — VC_OUTREACH_STAGES lives in the same
-- table — and a VC outreach card is not about a field. It stays null there, which the nullable
-- column already permits and the partial index below already ignores.
alter table public.kanban_cards
  add column if not exists venue_id bigint
    references public.fin_venues (id) on delete set null;

-- ── ONE FIELD, ONE CARD, ENFORCED BY THE DATABASE ────────────────────────────────────────────
-- The dialog's exact-name check catches the common case earlier and with a better message, but a
-- UI check is not a constraint: two people confirming the same field in two tabs both pass it.
-- PARTIAL, on `where venue_id is not null`, because a plain unique index would allow exactly one
-- unbound card in the whole table — every Confirmed card that has not been bound yet, plus every
-- VC card, is null.
create unique index if not exists kanban_cards_venue_id_key
  on public.kanban_cards (venue_id)
  where venue_id is not null;

comment on column public.kanban_cards.venue_id is
  'The fin_venues row this pipeline card is about. Null until a person binds it on the move to '
  'Confirmed, and always null on the VC board. launch_date is NOT copied here: it lives on '
  'fin_venues so Finance and Growth read one column.';
