"use client";

/* THE ONE fin_venues INSERT, AND NOW IT HAS TWO CALLERS.
 *
 * Finance › Field Costs creates a venue with its costs and its aliases; the Field Pipeline board
 * creates one the moment a card reaches Confirmed, with a name, a city and a launch date. Those are
 * different forms over the SAME row, so the insert is here rather than written twice — a second
 * venue creator is how two code paths end up disagreeing about what a venue minimally is.
 *
 * WHAT IS SHARED IS THE INSERT AND ITS DUPLICATE TRANSLATION. What is NOT shared is everything
 * around it: Field Costs then links an mdapi field and writes aliases, both best-effort and both
 * meaningless to the pipeline. Those stay with the caller that needs them.
 *
 * ── THE THREE COLUMNS, MEASURED ───────────────────────────────────────────────────────────────
 * fin_venues requires venue_name, city AND billing_type — all NOT NULL with no default, and `city`
 * is the one that fails first. Probed against the live table: a name alone raises
 * `23502 null value in column "city"`, adding the city raises the same on billing_type, and the
 * three together insert. Anything that writes this table has to supply all three, which is why they
 * are required here rather than optional with a hopeful default.
 */

import { supabase } from "@/lib/supabase";

/** The columns every caller must supply, plus whatever else that caller knows. */
export type FinVenueInsert = {
  venue_name: string;
  city: string;
  /* NO DEFAULT HERE, DELIBERATELY. It is NOT NULL in the database, and a default buried in a shared
   * helper is how a billing model gets chosen by nobody. Each caller states the value it means and
   * says so in its own UI. */
  billing_type: string;
} & Record<string, unknown>;

export type InsertedVenue = { id: number } & Record<string, unknown>;

/**
 * Inserts one `fin_venues` row and returns it.
 *
 * THROWS ON A DUPLICATE, WITH THE NAME AND CITY IN THE MESSAGE. The table carries a unique index on
 * (city, venue_name); a 23505 here means somebody already made this field, and the caller's job is
 * to say so rather than to retry.
 */
export async function insertFinVenue(fields: FinVenueInsert): Promise<InsertedVenue> {
  const { data, error } = await supabase
    .from("fin_venues")
    .insert(fields)
    .select()
    .single();

  if (error) {
    if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) {
      throw new Error(
        `A venue named "${fields.venue_name}" already exists in ${fields.city}. `
        + `Use a unique name or edit the existing entry.`,
      );
    }
    throw new Error(error.message);
  }
  return data as InsertedVenue;
}

/* THE VALUE A NEW FIELD STARTS ON, AND WHY IT IS SAFE.
 *
 * billing_type is NOT NULL and has no "unset" member — the only values in use are per_match (34
 * rows) and profit_share (4). A field arriving at Confirmed has no rate yet, so the question is
 * which value is honest in the absence of one.
 *
 * per_match IS, AND THE COST CODE PROVES IT. basisOf() already returns "per_match" as its own
 * fallback (fieldEconomics.ts:114), and a per_match venue with no cost_per_match and no
 * per_match_rate returns { amount: null, kind: "needs_override" } (:190) under the rule written at
 * :19 — "A COST IS NULL, NEVER ZERO, WHEN IT IS NOT RECORDED." So Finance sees a field needing a
 * rate, which is a work item, and never a field that appears to cost nothing.
 *
 * ANY UI THAT USES THIS MUST SAY SO. A billing model picked silently is still a billing model. */
export const NEW_FIELD_BILLING_TYPE = "per_match";
