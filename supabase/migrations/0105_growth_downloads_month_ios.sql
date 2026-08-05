-- 0105: iOS monthly downloads rollup for the App downloads KPI. ADDITIVE — a new
-- view alongside the android-only growth_downloads_month (0096), so nothing that
-- reads the existing view changes. Mirrors its shape (month, count) but filters
-- platform='ios'. app_downloads iOS rows are one per day (metric app_units).

CREATE OR REPLACE VIEW public.growth_downloads_month_ios AS
SELECT
  to_char(period_date::date, 'YYYY-MM') AS month,
  SUM(count)::bigint                     AS count
FROM public.app_downloads
WHERE platform = 'ios' AND period_grain = 'day'
GROUP BY 1;
