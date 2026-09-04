"use client";

import { useLayoutEffect, useState } from "react";

/* IS THIS A PHONE — one implementation, shared.
 *
 * 639.98px is the breakpoint already in the codebase (VeoMasterSchedule's month grid), and it
 * stays that so two views a manager moves between cannot disagree about where a phone ends.
 *
 * WHY A HOOK AND NOT CSS. `display:none` leaves the whole phone layout in the DOM at every width —
 * built, laid out, and hidden. On a board of any size that is real work done for nobody, and the
 * rule is that the phone work must not reach the desktop. Invisible is not the same as not there.
 *
 * useLayoutEffect, not useEffect: it runs BEFORE paint, so a phone never shows a frame of the
 * desktop layout first. It starts false so the server render and the first client render agree —
 * a phone gets one pre-paint correction, not a hydration mismatch.
 */
export const PHONE_QUERY = "(max-width: 639.98px)";

export function usePhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);
  useLayoutEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setIsPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return isPhone;
}
