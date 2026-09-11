-- city_manager_check_ins.manager_name becomes NULLABLE, and stops being a question.
--
-- WHY. Ryan filed a test check-in as "Ryan Mancuso" for Austin and the card came back titled
-- "Garrett Suits". That is not a bug in the card — it is the form asking a question whose answer is
-- thrown away. src/lib/checkIns.ts builds every status from MANAGERS.map() keyed on cityId, so the
-- card's title is MANAGERS[].name. manager_name is selected and read into CheckInRecord and is
-- never placed on CheckInEntry and never rendered anywhere. The CITY is the identity.
--
-- THE COLUMN STAYS AND THE DATA STAYS. The twelve imported rows carry names that were
-- reconstructed by joining submitting emails to app_users, and that exercise is what found two of
-- them misspelt in MANAGERS ("Yarra" -> Yara Usheta, "Willfried" -> Wilfried Nyamsi). Deleting the
-- column would throw away the only record of who actually filed each historical check-in.
--
-- IT BECOMES AN AUDIT FIELD, FILLED SERVER-SIDE. /api/city-check-ins/submit resolves it from
-- MANAGERS by city_identifier after validation. The public form does not ask and cannot set it —
-- it is not in the allowlist the route builds its row from.
--
-- NULL IS A REAL CASE, NOT A DEFECT. CHECK_IN_CITY_OPTIONS comes from cityScope.ts, which carries
-- WAW; MANAGERS has no Warsaw row. A Warsaw check-in therefore stores manager_name NULL, and that
-- is deliberate: a new city must be able to file before anyone remembers to add its manager. (Such
-- a row is stored and valid but currently appears on no card, because the dashboard iterates
-- MANAGERS — see the report; not fixed in this migration.)

ALTER TABLE city_manager_check_ins
  ALTER COLUMN manager_name DROP NOT NULL;

/* THE LENGTH CHECK IS RESTATED RATHER THAN LEFT TO LUCK. As written it was
 *     char_length(manager_name) BETWEEN 1 AND 120 AND ...
 * which ALREADY tolerates NULL, because char_length(NULL) is NULL, NULL BETWEEN is NULL, and a
 * CHECK passes on NULL rather than failing. That is a correct outcome reached by accident, and the
 * next person to read it cannot tell whether NULL was intended or overlooked. coalesce says it. */
ALTER TABLE city_manager_check_ins
  DROP CONSTRAINT IF EXISTS city_manager_check_ins_len_check;

ALTER TABLE city_manager_check_ins
  ADD CONSTRAINT city_manager_check_ins_len_check CHECK (
    -- NULL manager_name is allowed (no manager on file for that city); a PRESENT one must be 1-120.
    (manager_name IS NULL OR char_length(manager_name) BETWEEN 1 AND 120) AND
    char_length(coalesce(fields_contacted,   '')) <= 200  AND
    char_length(coalesce(fields_list,        '')) <= 4000 AND
    char_length(coalesce(field_progress,     '')) <= 4000 AND
    char_length(coalesce(match_manager,      '')) <= 4000 AND
    char_length(coalesce(marketing_channels, '')) <= 4000 AND
    char_length(coalesce(marketing_results,  '')) <= 4000 AND
    char_length(coalesce(win,                '')) <= 4000 AND
    char_length(coalesce(challenge,          '')) <= 4000 AND
    char_length(coalesce(focus,              '')) <= 4000
  );

-- city_identifier, month_ending and rating stay NOT NULL, and the rating CHECK (1-5) is untouched.
-- Those are the answer; the name was never read.
