// Registry of approved WhatsApp message templates the CRM can send.
// Client-safe (no server-only import): the composer's template modal
// reads it for labels + live preview, and /api/crm/send-template reads
// it to validate and build the Meta payload + the stored body text.
//
// Templates here are Meta-approved (not user-managed like canned
// responses). Adding one means: get it approved in Meta Business
// Suite, then add an entry below with the exact name, language code,
// and body text matching the approved template.

export type TemplateVariable = {
  key: string; // matches the {{key}} placeholder in bodyText
  label: string; // shown next to the input in the modal
  // "player" pre-fills from the thread's linked player; "manual" is
  // always operator-entered. Both are editable at send time.
  source: "player" | "manual";
  required: boolean;
  placeholder?: string;
};

export type WhatsAppTemplate = {
  name: string; // Meta template name (exact)
  languageCode: string; // Meta language code (exact)
  category: "MARKETING" | "UTILITY";
  label: string; // human label in the UI
  description: string;
  // Body text with {{key}} placeholders. Used for the live preview
  // and to render the exact text stored on the outbound message row.
  bodyText: string;
  variables: TemplateVariable[];
};

export const WHATSAPP_TEMPLATES: Record<string, WhatsAppTemplate> = {
  support_followup: {
    name: "support_followup",
    // Registered in WhatsApp Manager under language "en" (not en_US).
    // Sending en_US 404s with "does not exist in en_US".
    languageCode: "en",
    category: "MARKETING",
    label: "Support follow-up",
    description:
      "Re-engage a customer on a stale thread (past the 24-hour service window).",
    bodyText:
      "Hi {{customer_name}}, we have an update on your recent {{topic}}. Please reply here to continue our conversation.\n\n- MatchDay Support",
    variables: [
      {
        key: "customer_name",
        label: "Customer name",
        source: "player",
        required: true,
        placeholder: "e.g. Alex",
      },
      {
        key: "topic",
        label: "Topic",
        source: "manual",
        required: true,
        placeholder: "e.g. field booking",
      },
    ],
  },
};

export function getTemplate(name: string): WhatsAppTemplate | null {
  return WHATSAPP_TEMPLATES[name] ?? null;
}

// Substitute {{key}} placeholders with the provided values. Missing
// keys collapse to empty (the route validates required vars before
// this, so that only happens for optional vars).
export function renderTemplateBody(
  tpl: WhatsAppTemplate,
  vars: Record<string, string>,
): string {
  return tpl.bodyText.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    (vars[k] ?? "").toString(),
  );
}
