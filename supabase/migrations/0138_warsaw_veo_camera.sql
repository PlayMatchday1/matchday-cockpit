-- WARSAW GETS ITS CAMERA ROW, so Master Schedule renders for the Warsaw operator.
--
-- WHY THIS IS NEEDED AND WHY IT IS NOT COSMETIC. VeoMasterSchedule's Schedule view iterates
-- `week.cities`, and fetchVeoWeek builds that list from veo_camera_count — NOT from the matches.
-- Warsaw's three matches were reaching the payload and rendering nowhere: present and invisible.
-- Adding WAW to CITY_CODE_TO_DISPLAY stops them being dropped; this row is what draws them.
--
-- ONE CAMERA, because Ryan says Warsaw has a camera, singular, and nothing in the data contradicts
-- it: all three Warsaw matches sit on the single Warsaw field (1684, Hala Piłkarska Bemowo) and all
-- three carry the 🎥 name marker. There is exactly one field, so there is nothing for a second
-- camera to be on.
--
-- `city` IS THE DISPLAY STRING, matching CITY_CODE_TO_DISPLAY['WAW'] — veo_camera_count is keyed by
-- display name, not by identifier, which is why this reads "Warsaw" and not "WAW".
--
-- THIS DOES NOT RESOLVE VEO COVERAGE. That needs a veo_codes row, which needs a fin_venue_id, which
-- needs a fin_venues row for Warsaw and a fin_venue_fields link for field 1684 — none of which
-- exist. Warsaw will therefore show as UNCOVERED on the coverage grid, which is honest: no code is
-- registered yet. That chain is separate work.

insert into public.veo_camera_count (city, cameras, updated_by, updated_at)
values ('Warsaw', 1, 'migration:0138', now())
on conflict (city) do nothing;
