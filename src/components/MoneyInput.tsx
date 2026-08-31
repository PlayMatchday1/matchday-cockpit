"use client";

/* A MONEY FIELD YOU CAN TYPE IN. One component, both panels.
 *
 * ── WHAT IT FIXES ─────────────────────────────────────────────────────────────────────────────
 * Both panels bound the input's `value` to a FORMATTED string derived from cents on every render —
 * MatchPanel through centsToDollars(cur[k]), MatchEditor through (cents/100).toFixed(2). So the
 * field reformatted on every keystroke: it rendered "9.00", the caret landed in the cents, and
 * changing 9 to 12 was a fight. Neither panel handled focus or blur, so there was no existing
 * one to reuse and this is the one.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 *   FOCUS   select everything, so the first keystroke replaces rather than inserts.
 *   TYPING  show exactly what was typed, verbatim. The draft is the value while focused and no
 *           formatter touches it — that is what stops the caret being thrown into the cents.
 *   BLUR    drop the draft; the displayed value goes back to being derived from cents, two places.
 *
 * ── THE WIRE IS UNAFFECTED ────────────────────────────────────────────────────────────────────
 * This is the INPUT, not the payload. Prices are cents and the conversion stays with the caller:
 * onCents fires on every keystroke with the same value the old onChange produced, so the diff, the
 * dirty flag and the request body all behave exactly as before. A half-typed "12." parses to the
 * same cents as "12", which is why the draft is display-only and never the source of truth.
 */

import { useRef, useState } from "react";

export type MoneyInputProps = {
  /** Cents. "" or null means empty — the field shows nothing rather than "0.00". */
  cents: number | string | null | undefined;
  /** Fires per keystroke with cents, or "" when the field is cleared. */
  onCents: (next: number | "") => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  "data-testid"?: string;
  "aria-label"?: string;
};

const isEmpty = (v: unknown) => v === "" || v === null || v === undefined;

/** Cents -> "12.00". The display form, used whenever the field is NOT focused. */
export const formatCents = (v: number | string | null | undefined): string =>
  isEmpty(v) ? "" : (Number(v) / 100).toFixed(2);

/** "12" / "12." / "12.5" -> cents. Anything unparseable is "" so a half-typed value never
 *  becomes a NaN on the wire. */
export const parseDollars = (s: string): number | "" => {
  const t = s.trim();
  if (t === "") return "";
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? Math.round(n * 100) : "";
};

export default function MoneyInput({ cents, onCents, className, placeholder, disabled, ...rest }: MoneyInputProps) {
  /* THE DRAFT IS THE WHOLE MECHANISM. null means "not being typed in" and the field renders from
   * cents; a string means "the operator is typing" and the field renders that string untouched. */
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement | null>(null);

  return (
    <input
      {...rest}
      ref={ref}
      inputMode="decimal"
      className={className}
      placeholder={placeholder}
      disabled={disabled}
      value={draft ?? formatCents(cents)}
      onFocus={() => {
        setDraft(formatCents(cents));
        // SELECT ALL, so typing replaces. Deferred a tick: setting the draft re-renders, and a
        // selection made before that render is discarded by React writing `value`.
        requestAnimationFrame(() => ref.current?.select());
      }}
      onChange={(e) => {
        setDraft(e.target.value);        // verbatim — no formatter runs while focused
        onCents(parseDollars(e.target.value));
      }}
      onBlur={() => setDraft(null)}      // back to the two-decimal display, derived from cents
    />
  );
}
