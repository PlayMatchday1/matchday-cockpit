"use client";

// "TEXT THE PLAYERS" on Credit everyone who paid — the tick and, when it is on, the message box. ONE
// component for the match editor and the Gameday Ops match panel, so both send the same thing.
// The rules live in src/lib/creditText.ts; the route checks them again before any credit.

import { CREDIT_TEXT_PLACEHOLDERS, DEFAULT_CREDIT_TEXT, creditTextCounter, fillCreditText } from "@/lib/creditText";
import type { CreditPreview } from "@/lib/useCreditEveryone";

export default function CreditTextBox({ preview, notify, setNotify, message, setMessage, problem, canText, tickClass }: {
  preview: CreditPreview; notify: boolean; setNotify: (v: boolean) => void;
  message: string; setMessage: (v: string) => void; problem: string | null; canText: boolean; tickClass: string;
}) {
  const sample = preview.textPreview;
  const filled = sample && !problem ? fillCreditText(message, { firstName: sample.firstName, cents: sample.cents, field: preview.field, startDate: preview.startDate }) : null;
  const counter = creditTextCounter(filled ?? message);
  const n = preview.textRecipients;
  return (
    <div data-testid="creditall-text">
      {/* A SEPARATE TICK, OFF BY DEFAULT: it reaches real phones, so it is a thing somebody chose. */}
      <label className={tickClass} data-testid="creditall-notify-row">
        <input type="checkbox" data-testid="creditall-notify" checked={notify}
          disabled={!canText || !preview.notifyAvailable} onChange={(e) => setNotify(e.target.checked)} />
        <span>Text the players
          <small>{!canText ? "Texting needs SEND MESSAGES."
            : !preview.notifyAvailable ? "Texting is switched off."
              : "Only players whose credit lands get a text, each with their own amount. Cancelling sends its own text; this does not."}</small>
        </span>
      </label>
      {notify && (
        <div style={{ margin: "8px 0 4px", display: "flex", flexDirection: "column", gap: 6 }}>
          <textarea data-testid="creditall-message" rows={4} value={message} onChange={(e) => setMessage(e.target.value)}
            aria-label="Message to the players"
            style={{ width: "100%", border: "1px solid #cfd6d2", borderRadius: 8, padding: "8px 10px", fontSize: 14, lineHeight: 1.4, fontFamily: "inherit", resize: "vertical" }} />
          <div style={{ fontSize: 12, color: "#5e6b66" }}>
            Placeholders, filled for each player: {CREDIT_TEXT_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.
            {message !== DEFAULT_CREDIT_TEXT && <> <button type="button" data-testid="creditall-message-reset" onClick={() => setMessage(DEFAULT_CREDIT_TEXT)}
              style={{ background: "none", border: 0, padding: 0, color: "#0e3b2c", fontWeight: 600, textDecoration: "underline", cursor: "pointer", fontSize: 12 }}>Use the approved wording</button></>}
          </div>
          {problem ? (
            <div data-testid="creditall-message-problem" role="alert" style={{ fontSize: 13, fontWeight: 600, color: "#a83120" }}>{problem}</div>
          ) : (
            <div data-testid="creditall-message-preview" style={{ background: "#f7f7f3", border: "1px solid #e3e3db", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "#13241d" }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", color: "#7c8782", marginBottom: 3 }}>
                PREVIEW · {sample?.firstName?.trim() || "first recipient"}
              </div>
              {filled ?? "Nobody to text."}
            </div>
          )}
          <div data-testid="creditall-message-meta" style={{ fontSize: 12, color: counter.warn ? "#8a5a00" : "#5e6b66", fontWeight: counter.warn ? 600 : 400 }}>
            Up to {n} player{n === 1 ? "" : "s"} · {counter.chars} characters · {counter.segments} SMS segment{counter.segments === 1 ? "" : "s"}
            {counter.warn ? " — over one segment, so each player's text is sent (and billed) as several." : ""}
          </div>
        </div>
      )}
    </div>
  );
}
