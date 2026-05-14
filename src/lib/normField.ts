const SAN_JUAN_DIEGO_ALIASES = [
  "San Juan Diego Catholic High School",
  "Premier at SJD",
  "San Juan Diego Catholic HS",
];

export function normField(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";

  if (SAN_JUAN_DIEGO_ALIASES.includes(trimmed)) return "San Juan Diego";

  if (
    trimmed.includes("Tourney at Soccer Central") ||
    trimmed.includes("Soccer Central Complex") ||
    trimmed.includes("Soccer Central Field")
  ) {
    return "Soccer Central";
  }
  if (
    trimmed.includes("ATH Pearland") ||
    trimmed.includes("Tourney ATH Pearland")
  ) {
    return "ATH Pearland";
  }
  if (
    trimmed.includes("North East Metropolitan Park") ||
    trimmed.includes("NEMP")
  ) {
    return "NEMP";
  }
  if (
    trimmed.includes("Stadium Field at Round Rock") ||
    trimmed.includes("Round Rock")
  ) {
    return "Round Rock";
  }
  // "Athletic Training Center" is the Indoor venue's full name — it
  // doesn't contain the word "Indoor" so the substring check alone
  // mis-bucketed those 25 STL matches into Outdoor.
  if (
    trimmed.includes("Lou Fusz") &&
    (trimmed.includes("Indoor") || trimmed.includes("Training Center"))
  ) {
    return "Lou Fusz Indoor";
  }
  if (trimmed.includes("Lou Fusz")) return "Lou Fusz Outdoor";
  if (trimmed.includes("Onion Creek")) return "Onion Creek";
  if (trimmed.includes("Hammond Park")) return "Hammond Park";
  if (trimmed.includes("PRUMC")) return "PRUMC";
  if (trimmed.includes("Scissortail")) return "Scissortail Park";
  if (trimmed.includes("Bicentennial")) return "Bicentennial Park";
  if (trimmed.includes("Majestic")) return "Majestic Gardens";
  if (trimmed.includes("PAC GLOBAL") || trimmed.includes("PAC Global")) {
    return "PAC Global";
  }
  // Match fin_venues canonical (San Antonio row is "STAR", not the
  // longer "STAR Soccer Complex"). Without alignment, fin_revenue's
  // "STAR" and the mdapi-derived "STAR Soccer Complex" show as two
  // rows in Field Ranking even though they're the same venue.
  if (trimmed.includes("STAR Soccer")) return "STAR";
  if (trimmed.includes("Hattrick")) return "The Hattrick";
  if (trimmed.includes("Stony Point")) return "Stony Point";
  if (trimmed.includes("Galatzan")) return "Galatzan Park";
  if (trimmed.includes("ATH Katy")) return "ATH Katy";
  // Match fin_venues canonical (Houston row is "KISC (Katy Intl)").
  // Without alignment, fin_revenue's "KISC (Katy Intl)" and the
  // mdapi-derived "Katy International" show as two rows in Field
  // Ranking even though they're the same physical venue.
  if (trimmed.includes("Katy International")) return "KISC (Katy Intl)";
  if (trimmed.includes("Centennial Commons")) return "Centennial Commons";
  if (trimmed.includes("Carroll")) return "Carroll Senior HS";

  return trimmed;
}
