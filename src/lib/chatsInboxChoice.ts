"use client";

// WHICH PLAYER CHATS A STAFF MEMBER SEES — the old page or Player Chats 2.0 (Ryan 2026-11-06, Q1).
//
// PER BROWSER, NOT PER ACCOUNT. Stored the way the page already stores per-staff settings:
// localStorage keyed on the app_users id (crm:inbox2:v1:<id>), like crm:contextOpen:v1:<id>. No
// DDL. So turning it on for someone means they press "Try the new inbox" on their own device —
// nobody can turn it on for another person from here. Nothing stored = the old page.
//
// The page and the Match Ops layout (which narrows the rail to 64px on the new page) both read it,
// so a change fires a window event and both follow without a reload.

import { useCallback, useEffect, useState } from "react";

export const inbox2Key = (appUserId: string) => `crm:inbox2:v1:${appUserId}`;
const EVENT = "crm:inbox2-changed";

function read(appUserId: string | null | undefined): boolean {
  if (!appUserId) return false;
  try { return window.localStorage.getItem(inbox2Key(appUserId)) === "1"; } catch { return false; }
}

/** `on` is null until the stored choice has been read, so neither page flashes before the other. */
export function useInbox2Choice(appUserId: string | null | undefined): { on: boolean | null; set: (next: boolean) => void } {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!appUserId) return;
    setOn(read(appUserId));
    const sync = () => setOn(read(appUserId));
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, [appUserId]);
  const set = useCallback((next: boolean) => {
    if (!appUserId) return;
    try { window.localStorage.setItem(inbox2Key(appUserId), next ? "1" : "0"); } catch { /* private mode: stays as is */ }
    setOn(read(appUserId));
    window.dispatchEvent(new Event(EVENT));
  }, [appUserId]);
  return { on, set };
}
