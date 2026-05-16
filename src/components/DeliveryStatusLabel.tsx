// Outbound delivery state rendered below the timestamp on each
// outbound message bubble in /crm. Hoisted from CrmClient so the
// new bubble component can import it without dragging in the rest
// of the page tree.
//
// Visual idiom mirrors WhatsApp: single check = accepted by
// provider, double check = delivered to device, mint-tinted double
// check = read. Shipped in PR #32 — see migration 0033 for the
// underlying delivery_status column shape.

import { Check, CheckCheck } from "lucide-react";

export type DeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export default function DeliveryStatusLabel({
  status,
}: {
  status: DeliveryStatus;
}) {
  if (status === "failed") {
    return (
      <span className="ml-1 text-coral-hover">· failed to deliver</span>
    );
  }
  if (status === "pending") {
    return <span className="ml-1 text-deep-green/45">· sending…</span>;
  }
  if (status === "delivered") {
    return (
      <span className="ml-1 inline-flex items-center gap-0.5 text-deep-green/55">
        · delivered
        <Check aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "read") {
    return (
      <span className="ml-1 inline-flex items-center gap-0.5 text-mint-hover">
        · read
        <CheckCheck aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    );
  }
  // 'sent' — quiet single check, no extra word. Matches the
  // mobile-app idiom for "accepted by server, not yet on the
  // recipient's device."
  return (
    <span className="ml-1 inline-flex items-center text-deep-green/50">
      <Check aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
}
