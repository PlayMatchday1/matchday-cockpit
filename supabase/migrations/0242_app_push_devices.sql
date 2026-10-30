-- 0242 WHICH DEVICE A PUSH TOKEN BELONGS TO, AND WHICH TOKEN A PUSH WENT TO (Ryan, 2026-10-30).
-- The app reports these when it registers (src/lib/push.ts deviceInfo); /api/app/push-token stores
-- them. aps_environment is the APNs environment the token was registered for: a simulator is
-- sandbox only, which is why sending it through production came back BadDeviceToken.

BEGIN;

ALTER TABLE public.app_push_tokens
  ADD COLUMN IF NOT EXISTS device_label     text,
  ADD COLUMN IF NOT EXISTS build_type       text CHECK (build_type IN ('simulator_dev', 'simulator_release', 'device_dev', 'testflight', 'app_store', 'device_release')),
  ADD COLUMN IF NOT EXISTS aps_environment  text CHECK (aps_environment IN ('development', 'production')),
  ADD COLUMN IF NOT EXISTS app_version      text;

-- Which token each push went to, so a receipt's DeviceNotRegistered can remove exactly that token
-- and a receipt can always be matched to a device.
ALTER TABLE public.app_push_log ADD COLUMN IF NOT EXISTS token text;

COMMIT;
