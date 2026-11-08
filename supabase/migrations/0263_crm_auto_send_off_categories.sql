-- 0263: THE DIAL'S "OFF" SETTING for the Player Chats support agent (Ryan, 2026-11-08).
--
-- Each category is auto-send (in auto_categories), draft only (in neither list), or off (here): the
-- agent stays out of it entirely and the card shows no draft. The code reads this table with
-- select("*") and treats a missing column as "nothing is off", so it is safe in either order; "Off"
-- can't be saved until this is applied.

ALTER TABLE crm_auto_send_config
  ADD COLUMN IF NOT EXISTS off_categories text[] NOT NULL DEFAULT '{}';

NOTIFY pgrst, 'reload schema';
