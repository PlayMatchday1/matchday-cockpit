// Google Chat notification helper. Phase 1 use case: fire a card to
// our Google Chat space when a NEW (first-ever) WhatsApp thread is
// created by an inbound message.
//
// Hard invariant: this helper NEVER throws. The WhatsApp webhook
// must reply 200 to Meta within ~1s or Meta retries — letting a
// slow / failed Google Chat call propagate would cause duplicate
// thread creation. Errors are swallowed + logged.

import "server-only";

const COCKPIT_BASE_URL =
  process.env.NEXT_PUBLIC_COCKPIT_BASE_URL ??
  "https://matchday-clubhouse.vercel.app";

// Escape only what's needed to keep player message bodies from
// breaking the Google Chat card text widget (which is HTML-aware).
function escapeForCardText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type NewWhatsAppThreadNotification = {
  threadId: string;
  cityCode: string | null;
  playerPhone: string; // E.164
  messageBody: string;
};

export async function notifyNewWhatsAppThread(
  payload: NewWhatsAppThreadNotification,
): Promise<void> {
  const webhook = process.env.GCHAT_WEBHOOK_URL;
  if (!webhook) {
    console.warn(
      "[whatsapp:gchat] GCHAT_WEBHOOK_URL not configured; skipping notification",
    );
    return;
  }

  const subtitleParts: string[] = [];
  if (payload.cityCode) subtitleParts.push(payload.cityCode);
  subtitleParts.push(payload.playerPhone);
  const subtitle = subtitleParts.join(" · ");

  const preview = payload.messageBody.slice(0, 100);

  const card = {
    cardsV2: [
      {
        cardId: "whatsapp-new-thread",
        card: {
          header: {
            title: "📱 New WhatsApp",
            subtitle,
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: escapeForCardText(preview) } },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: "Open in Cockpit",
                        onClick: {
                          openLink: {
                            url: `${COCKPIT_BASE_URL}/crm?threadId=${encodeURIComponent(payload.threadId)}`,
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };

  // 3-second timeout — well under Meta's webhook retry window. If
  // Google Chat is slow we'd rather skip the notification than have
  // Meta retry.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
      signal: ac.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(
        `[whatsapp:gchat] non-2xx: ${resp.status} ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    // AbortError or network failure — swallowed by design.
    console.warn(
      "[whatsapp:gchat] notification failed:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(t);
  }
}
