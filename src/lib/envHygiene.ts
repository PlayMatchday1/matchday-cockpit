// Detect-only whitespace smoke detector for credentials we deliberately do NOT
// trim (because trimming them would be wrong or risky). It NEVER modifies, trims,
// or throws — it only warns once at startup, naming any variable whose raw value
// differs from its trimmed form, and emitting ONLY the variable name and the
// character-count delta. Never the value, a prefix/suffix of it, or a hash.
//
// Why these five and why detect-not-fix:
//   CRON_SECRET          — compared constant-time against a Bearer Vercel/GitHub
//                          build from the SAME env; trimming one side desyncs. But
//                          a trailing newline can't survive an HTTP header, so if
//                          cron works there's none — and if flagged, cron is
//                          already silently broken.
//   META_APP_SECRET      — HMAC key; a newline changes every digest → every webhook
//   WHATSAPP_VERIFY_TOKEN   verification fails. Whitespace is never correct here,
//   VEO_INBOUND_SECRET      only undetected. Same asymmetry.
//   MATCHDAY_API_PASSWORD — passwords MAY legitimately end in whitespace, so we
//                          must not trim; but flagging it is still useful signal.
//
// FIRSTMATCH_LEDGER_SALT and TELNYX_PUBLIC_KEY are fully exempt (not checked): the
// salt's bytes are load-bearing in every historical hash, and a PEM legitimately
// ends in a newline.

const DETECT_ONLY = [
  "CRON_SECRET",
  "MATCHDAY_API_PASSWORD",
  "MATCHDAY_PROD_API_PASSWORD",
  "MATCHDAY_STAGE_API_PASSWORD",
  "META_APP_SECRET",
  // The ADS token — a Business Manager system user token, ads_read only. Distinct from
  // META_ACCESS_TOKEN above, which is scoped for WhatsApp Business messaging and must never be
  // used for ads. Sent as an Authorization header, never as an access_token query parameter, so it
  // cannot leak into a logged URL; see redactMetaError in metaAdSpend.ts for the second belt.
  "META_ADS_ACCESS_TOKEN",
  /* The WordPress submissions key. Travels in an X-MD-Key HEADER, never a query parameter, so it
   * cannot survive into a logged URL; redactWp in wpSubmissionsSync is the second belt. */
  "WP_SUBMISSIONS_KEY",
  "WHATSAPP_VERIFY_TOKEN",
  "VEO_INBOUND_SECRET",
] as const;

export function checkEnvWhitespace(): void {
  const flagged: string[] = [];
  for (const name of DETECT_ONLY) {
    const raw = process.env[name];
    if (raw == null) continue; // unset is not a whitespace problem
    const delta = raw.length - raw.trim().length; // count of leading/trailing ws chars only
    if (delta !== 0) flagged.push(`${name} (+${delta})`);
  }
  if (flagged.length > 0) {
    // ONE consolidated line. Name + char-count delta only — never the value.
    console.warn(
      `[env-hygiene] leading/trailing whitespace detected on: ${flagged.join(", ")} — ` +
        `NOT trimmed (these are compared/load-bearing). If the guarded path works today there is none; ` +
        `if flagged, that path may be silently broken. Re-save the variable without whitespace.`,
    );
  }
  // If nothing differs, log nothing at all.
}
