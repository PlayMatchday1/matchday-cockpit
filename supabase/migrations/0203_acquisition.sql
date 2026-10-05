-- 0203 — ACQUISITION PAGE: the daily source tables and the sync-log allowlist (Ryan, 2026-10-04).
--
-- Applied by hand in the Supabase SQL Editor. Server-only tables (RLS on, no anon/authenticated
-- grants), read by the Acquisition route with the service role, like the Meta tables (0184).
--
-- fin_sync_log's allowlist is 0197's — every value present in the table on 2026-10-04 — plus the
-- four new sync sources. A source missing from it makes the sync's log insert fail silently.

BEGIN;

-- Page path / download tag → city. New pages are a row here, not a code change.
CREATE TABLE public.acq_page_map (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_kind  text NOT NULL CHECK (match_kind IN ('path_exact','path_prefix','tag')),
  pattern     text NOT NULL CHECK (btrim(pattern) <> ''),
  market_key  text,                                   -- fin_meta_adset.market_key; NULL = site-wide
  page_kind   text NOT NULL CHECK (page_kind IN ('home','sitewide','cities','city','venue','blog','other')),
  label       text NOT NULL CHECK (btrim(label) <> ''),
  sort_order  double precision NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acq_page_map_uq UNIQUE (match_kind, pattern)
);

-- Search Console, per page per day. Position is stored × impressions so a range averages correctly.
CREATE TABLE public.acq_gsc_page_daily (
  day                    date NOT NULL,
  page_url               text NOT NULL,
  clicks                 integer NOT NULL CHECK (clicks >= 0),
  impressions            integer NOT NULL CHECK (impressions >= 0),
  position_x_impressions numeric(14,2) NOT NULL CHECK (position_x_impressions >= 0),
  synced_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, page_url)
);

-- GA4 website (485975225): traffic per page per day. Visits = sessions (additive across days/pages).
CREATE TABLE public.acq_web_page_daily (
  day        date NOT NULL,
  page_path  text NOT NULL,
  sessions   integer NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  users      integer NOT NULL DEFAULT 0 CHECK (users >= 0),
  views      integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  synced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, page_path)
);

-- GA4 website: store clicks. 'outbound_link' = click events to apps.apple.com / play.google.com;
-- 'app_store_click' = the tagged event from Oct 1.
CREATE TABLE public.acq_web_store_click_daily (
  day        date NOT NULL,
  page_path  text NOT NULL,
  method     text NOT NULL CHECK (method IN ('outbound_link','app_store_click')),
  store      text NOT NULL DEFAULT '' CHECK (store IN ('','apple','google')),
  tag        text NOT NULL DEFAULT '',
  clicks     integer NOT NULL CHECK (clicks >= 0),
  synced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, page_path, method, store, tag)
);

-- GA4 app (349835849): dynamic_link_first_open and any later app events, per platform per day.
CREATE TABLE public.acq_app_event_daily (
  day          date NOT NULL,
  event_name   text NOT NULL,
  platform     text NOT NULL,
  event_count  integer NOT NULL CHECK (event_count >= 0),
  users        integer NOT NULL DEFAULT 0 CHECK (users >= 0),
  synced_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, event_name, platform)
);

-- App Store Connect Analytics Reports, aggregated to the dimensions the page uses.
CREATE TABLE public.acq_asc_downloads_daily (
  day            date NOT NULL,
  report         text NOT NULL CHECK (report IN ('standard','detailed')),
  download_type  text NOT NULL,
  source_type    text NOT NULL DEFAULT '',
  source_info    text NOT NULL DEFAULT '',
  campaign       text NOT NULL DEFAULT '',
  counts         integer NOT NULL CHECK (counts >= 0),
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, report, download_type, source_type, source_info, campaign)
);

ALTER TABLE public.acq_page_map              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acq_gsc_page_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acq_web_page_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acq_web_store_click_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acq_app_event_daily       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acq_asc_downloads_daily   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.acq_page_map, public.acq_gsc_page_daily, public.acq_web_page_daily,
  public.acq_web_store_click_daily, public.acq_app_event_daily, public.acq_asc_downloads_daily
  FROM anon, authenticated;

ALTER TABLE public.fin_sync_log DROP CONSTRAINT IF EXISTS fin_sync_log_source_check;
ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_source_check
  CHECK (source IN (
    'stripe-api','mdapi-reviews','mdapi-subscriptions','mdapi-promocodes','mdapi-matches',
    'mdapi-users','mdapi-users-full','mdapi-users-lens-snapshot','membership-snapshots',
    'membership-prices','manager-pay-recompute','firstmatch-ledger','telnyx-sms','play-installs',
    'app-store-installs','google-calendar','meta-ad-spend','wp-submissions',
    'stripe-txn-backfill','stripe-txn',
    'gsc-pages','ga4-web','ga4-app','asc-analytics'
  ));

COMMIT;
