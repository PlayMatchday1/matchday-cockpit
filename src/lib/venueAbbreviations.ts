// Lookup map from schedule_master.detail (the full venue + field
// name as stored in the legacy MatchDay master-schedule HTML) to
// the short code the ops team plans with day-to-day. Used by the
// /cities Master Schedule tab so a 7-column Mon-Sun grid can fit
// several match bubbles per day cell.
//
// If a new venue gets seeded later without a code here, getAbbr
// falls back to the first three alphanumeric characters of the
// detail string, uppercased. That keeps the UI readable while
// signalling that the map needs an update.

export const VENUE_ABBREVIATIONS: Record<string, string> = {
  // Austin
  "NEMP Field 12": "N12",
  "NEMP Field 14": "N14",
  "Onion Creek": "OC",
  "Round Rock MP - Field 1 (Syn)": "RR1",
  "Round Rock MP - Field 6 (Gr)": "RR6",
  "Round Rock MP - Field 7 (Syn)": "RR7",
  "Round Rock MP - Field 8 (Syn)": "RR8",
  "Round Rock MP - Field 9 (Syn)": "RR9",
  "Round Rock MP - Field 10 (Syn)": "RR10",
  "San Juan Diego (SJD)": "SJD",
  "Stony Point": "SP",
  "The Hattrick": "HT",
  // Houston
  "ATH Katy": "AK",
  "ATH Pearland": "AP",
  "Katy Intl (KISC)": "KI",
  "PAC Global": "PAC",
  // San Antonio
  "Soccer Central - SC Field 3": "SC3",
  "Soccer Central - SC Field 4": "SC4",
  "Soccer Central - SC Field 4A": "SC4A",
  "STAR Soccer Complex": "STAR",
  // Dallas
  "Bicentennial Park": "BP",
  "Carroll Senior HS": "CSH",
  "Majestic Gardens": "MG",
  // Atlanta
  "Hammond Park": "HP",
  "PRUMC": "PR",
  // St. Louis
  "Centennial Commons": "CC",
  "Lou Fusz Outdoor (Field 5)": "LF5",
  "Lou Fusz Outdoor (Field 10)": "LF10",
  // OKC
  "Scissortail Park": "STP",
  // El Paso
  "Galatzan Park": "GP",
};

export function getAbbr(detail: string): string {
  if (detail in VENUE_ABBREVIATIONS) return VENUE_ABBREVIATIONS[detail];
  const fallback = detail.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase();
  return fallback || "??";
}
