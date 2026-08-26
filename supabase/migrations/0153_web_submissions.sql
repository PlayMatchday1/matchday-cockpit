-- 0153 — playmatchday.com form submissions: the raw mirror, the contact, and the sync source.
--
-- MIGRATION BEFORE CODE, and here it has teeth: runWithLog INSERTS the fin_sync_log row BEFORE
-- running the sync and returns ok:false WITHOUT RUNNING IT if the source is not on the CHECK
-- allowlist. A missing source does not produce an unlogged sync — it produces a sync that silently
-- never happens. That has cost a round trip twice now ('mdapi-users-full', 'meta-ad-spend').
--
-- ── TWO TABLES, AND THE BOUNDARY BETWEEN THEM IS THE POINT ─────────────────────────────────────
--
-- web_submissions is a RAW MIRROR. One row per submission, never edited by Clubhouse. It is what
-- the website recorded, and it stays that way so a re-sync is always safe.
--
-- web_contacts is CLUBHOUSE-OWNED. One row per (stream, lower(email)) carrying status, owner and
-- notes. OUTREACH STATE ATTACHES TO THE PERSON, NOT THE SUBMISSION: 25 emails have more than one
-- submission and ngoudafaye@outlook.com has ten. Keying outreach on the submission would reset
-- someone's status every time they applied again, which is the opposite of what the page is for.

alter table public.fin_sync_log
  drop constraint if exists fin_sync_log_source_check;
alter table public.fin_sync_log add constraint fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-full','mdapi-users-lens-snapshot','membership-snapshots',
    'membership-prices','manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs',
    'app-store-installs','google-calendar','meta-ad-spend','wp-submissions'
  ));

create table if not exists public.web_submissions (
  submission_id   bigint      primary key,          -- the site's own id; the paging key
  element_id      text        not null,             -- WHICH FORM. Every label lookup is keyed on it.
  form_name       text,
  post_id         bigint,
  referer         text,
  wp_status       text,                             -- the site's status, not ours
  is_read         boolean,
  created_at      timestamptz,
  created_at_gmt  timestamptz,
  -- The submission exactly as received, raw keys and all. Labels are resolved on READ against the
  -- form registry, never baked in here — the four unrecoverable forms would otherwise be frozen
  -- with whatever guess was current on import day.
  fields          jsonb       not null default '{}'::jsonb,

  -- Derived on import, stored so the page can filter without re-parsing 664 rows every load.
  stream          text        not null check (stream in ('team','partner')),
  email           text,                             -- lowercased; joins to web_contacts
  city_code       text,                             -- ATX / DFW / ... or null when unmapped
  -- HOW WE GOT THE CITY. A derived value that looks typed is one nobody will ever question, so the
  -- source travels with it and the page renders 'zip' differently from 'city'.
  city_source     text        not null default 'none' check (city_source in ('city','zip','none')),
  city_raw        text,
  -- QUARANTINE, NEVER DELETE. 437 of 492 partnership rows are one bot. A rule that deletes cannot
  -- be audited when it is wrong, and this one will be wrong eventually.
  is_spam         boolean     not null default false,
  -- element_id in no label map: keep the raw keys and SAY SO rather than mislabelling. 109 rows.
  unresolved      boolean     not null default false,
  imported_from   text        not null default 'csv' check (imported_from in ('csv','sync')),
  synced_at       timestamptz not null default now()
);

create index if not exists web_submissions_stream_idx  on public.web_submissions (stream, created_at desc);
create index if not exists web_submissions_email_idx   on public.web_submissions (email);
create index if not exists web_submissions_city_idx    on public.web_submissions (city_code);
create index if not exists web_submissions_element_idx on public.web_submissions (element_id);

create table if not exists public.web_contacts (
  stream      text        not null check (stream in ('team','partner')),
  email       text        not null,                 -- ALREADY LOWERCASED by the importer
  status      text        not null default 'New'
                check (status in ('New','Contacted','Interviewing','Hired','Passed')),
  owner       text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (stream, email)
);

-- THE LABEL REGISTRY. Two forms still resolve from ?forms=1; four were edited or replaced and
-- their labels exist only in the CSV export. Both sources live here, keyed on element_id, because
-- THE SAME FIELD ID MEANS DIFFERENT THINGS ON DIFFERENT FORMS — field_dff8b68 is Company on the
-- partnerships form and Last Name on the team application.
create table if not exists public.web_form_labels (
  element_id  text        not null,
  field_id    text        not null,
  label       text        not null,
  form_name   text,
  source      text        not null check (source in ('forms-api','csv')),
  updated_at  timestamptz not null default now(),
  primary key (element_id, field_id)
);

-- PII: real names, emails and phones for 158 people. Same handling as player data — service role
-- only. City confinement is enforced at the ROUTE on the parsed identity, never by hiding a filter.
revoke all on public.web_submissions, public.web_contacts, public.web_form_labels from anon, authenticated;
grant select on public.web_submissions, public.web_contacts, public.web_form_labels to service_role;

-- VERDICT ROW.
select
  (select count(*) from pg_constraint
     where conname = 'fin_sync_log_source_check'
       and pg_get_constraintdef(oid) like '%wp-submissions%') = 1        as source_allowed,
  (select to_regclass('public.web_submissions')  is not null)            as submissions_table,
  (select to_regclass('public.web_contacts')     is not null)            as contacts_table,
  (select to_regclass('public.web_form_labels')  is not null)            as labels_table,
  (select count(*) from public.web_submissions)                          as submissions_rows,
  (select count(*) from public.web_contacts)                             as contacts_rows;
