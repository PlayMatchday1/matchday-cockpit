// Small, understated channel marker rendered on CRM inbox rows
// alongside the city chip. Two variants:
//   - "sms"      → MessageSquare in muted slate
//   - "whatsapp" → MessageCircle in mint
//
// Brand-icon note: lucide-react doesn't ship a WhatsApp brand mark
// (licensing) and we deliberately chose not to inline an SVG for
// the brand logo this phase. MessageCircle in mint reads as
// "WhatsApp-y" without dragging in a trademark; if/when we want
// the real brand mark, swap the import here only.

import { MessageCircle, MessageSquare } from "lucide-react";

export type CrmChannel = "sms" | "whatsapp";

export default function ChannelChip({ channel }: { channel: CrmChannel }) {
  if (channel === "whatsapp") {
    return (
      <span
        title="WhatsApp"
        aria-label="WhatsApp"
        className="inline-flex shrink-0 items-center text-mint-hover"
      >
        <MessageCircle aria-hidden className="h-3 w-3" strokeWidth={2.25} />
      </span>
    );
  }
  return (
    <span
      title="SMS"
      aria-label="SMS"
      className="inline-flex shrink-0 items-center text-deep-green/45"
    >
      <MessageSquare aria-hidden className="h-3 w-3" strokeWidth={2.25} />
    </span>
  );
}

// Long-form label for the conversation header ("via SMS" / "via
// WhatsApp"). Pulled into the chip module so the source of truth
// for channel display strings lives in one place.
export function channelDisplay(channel: CrmChannel): string {
  return channel === "whatsapp" ? "WhatsApp" : "SMS";
}
