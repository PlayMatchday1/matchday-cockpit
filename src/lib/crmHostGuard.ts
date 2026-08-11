import "server-only";
// Outbound-host allowlist for CRM sends (Phase 19 Step 1). The MatchDay write guard does not
// apply here — CRM sends post to Meta (WhatsApp Cloud API) and Telnyx (SMS), not the MatchDay
// API — but the PRINCIPLE does: validate the PARSED host of every app-constructed outbound URL
// against a hardcoded allowlist, never a string prefix. `https://graph.facebook.com.evil.com/…`
// parses to host `graph.facebook.com.evil.com` and is REJECTED; a `startsWith("https://graph.
// facebook.com")` check would have waved it straight through. `https://graph.facebook.com@evil.com`
// (userinfo trick) parses to host `evil.com` — also rejected. Exact host match only.
//
// Coverage note: only the WhatsApp path builds its URL in our code (src/lib/whatsapp.ts), so the
// guard is applied there. The SMS path hands off to the Telnyx SDK, which targets its own fixed
// `api.telnyx.com` and is never given an app-constructed URL — there is no prefix to inject — so
// that host is in the allowlist for completeness but there is no app URL to check on that path.

export const CRM_ALLOWED_HOSTS = ["graph.facebook.com", "api.telnyx.com"] as const;

export class OutboundHostError extends Error {
  constructor(public readonly host: string) {
    super(`Refusing CRM outbound request to disallowed host: ${host}`);
    this.name = "OutboundHostError";
  }
}

// Throws OutboundHostError unless the URL's parsed host is EXACTLY one of the allowlisted hosts.
export function assertAllowedOutboundHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase(); // host includes any :port — a non-default port fails the exact match
  } catch {
    throw new OutboundHostError(String(url));
  }
  if (!(CRM_ALLOWED_HOSTS as readonly string[]).includes(host)) {
    throw new OutboundHostError(host);
  }
}
