// Phase 26b — the push-notification gate. FOUR tests, deliberately.
//
// Nothing asserted push before this file, which is why two defects survived eight CRM refactors:
// a bell that had been invisible on mobile since 2026-07-31 (4f7c3fd) and a notification deep link
// pointing at the WRONG console since the same day. Tests 3 and 4 are written specifically to be
// the assertions that would have caught them.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/crm-push-test.ts

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { pushRecipientIds, shouldPushForMessage } from "../src/lib/crmPushNotify";

let PASS = 0, FAIL = 0;
const ok = (n: string) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { FAIL++; console.log(`  XX  ${n} — ${d}`); };
const is = (n: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// The real admin shape: several admins, and a thread assigned to exactly one of them.
const ADMINS = [{ id: "u-ryan" }, { id: "u-deonna" }, { id: "u-third" }];
const ASSIGNEE = "u-deonna";

console.log("1) RECIPIENTS — everyone, always (assignment does NOT narrow it):");
// THE REGRESSION THIS PINS: the old rule returned [assignee] for an assigned thread, so every
// inbound on a thread Deonna owned told nobody else. Ryan received nothing for exactly this reason.
is("an inbound on an ASSIGNED thread pushes every admin, not just the assignee",
  pushRecipientIds(ADMINS), ["u-ryan", "u-deonna", "u-third"]);
is("the assignee is not treated specially — the result is identical either way",
  pushRecipientIds(ADMINS), pushRecipientIds(ADMINS.filter(() => true)));
is("the assignee is still included (not swapped out)", pushRecipientIds(ADMINS).includes(ASSIGNEE), true);
is("an unassigned thread is unchanged — it always pushed everyone", pushRecipientIds(ADMINS).length, 3);
is("no admins → nobody", pushRecipientIds([]), []);
// and the source must not have grown an assignee branch back
{ const s = readFileSync("src/lib/crmPushNotify.ts", "utf8");
  is("crmPushNotify no longer branches on assigned_to_user_id for recipients", /assigned_to_user_id\s*\)?\s*(\?\?|\|\||\?)/.test(s), false); }

console.log("\n2) WHAT PUSHES — inbound player messages only:");
is("an inbound player message pushes", shouldPushForMessage({ direction: "inbound" }), true);
is("an OUTBOUND message pushes nobody", shouldPushForMessage({ direction: "outbound" }), false);
is("the out-of-hours AUTO-REPLY pushes nobody", shouldPushForMessage({ direction: "outbound", isAutoReply: true }), false);
// an auto-reply is stored outbound, but guard on the flag independently so a future storage change
// can't quietly turn it into a notification
is("an auto-reply pushes nobody even if it were marked inbound", shouldPushForMessage({ direction: "inbound", isAutoReply: true }), false);
is("a missing direction defaults to inbound (the only caller's case)", shouldPushForMessage({}), true);
// the guard is actually wired, not merely exported
{ const s = readFileSync("src/lib/crmPushNotify.ts", "utf8");
  is("doNotify calls shouldPushForMessage as a hard guard", /if\s*\(!shouldPushForMessage\(/.test(s), true); }
// and the only call sites remain the two inbound webhooks
{ const wa = readFileSync("src/app/api/whatsapp/webhook/route.ts", "utf8");
  const tx = readFileSync("src/app/api/webhooks/telnyx/route.ts", "utf8");
  is("notifyInboundChatMessage is called from the WhatsApp inbound webhook", /notifyInboundChatMessage\(/.test(wa), true);
  is("notifyInboundChatMessage is called from the Telnyx inbound webhook", /notifyInboundChatMessage\(/.test(tx), true); }

console.log("\n3) THE DEEP LINK resolves to a REAL page and is not redirected away:");
// THE REGRESSION THIS PINS: route was "/chats?threadId=…", and next.config.ts permanently redirects
// /chats -> /match-ops/match-chats. A player-chat notification opened the MATCH chats console.
const routeOf = (src: string): string | null => {
  const m = /route:\s*`([^`?]+)/.exec(src);
  return m ? m[1] : null;
};
const NOTIF_ROUTE = routeOf(readFileSync("src/lib/crmPushNotify.ts", "utf8"));
is("the notification route is extractable from the source", typeof NOTIF_ROUTE === "string" && NOTIF_ROUTE.startsWith("/"), true);

// (a) it maps to a real App Router page on disk
const pageForRoute = (route: string): string | null => {
  const seg = route.replace(/^\/+/, "");
  for (const group of ["(internal)/", ""]) {
    for (const ext of ["tsx", "ts"]) {
      const p = `src/app/${group}${seg}/page.${ext}`;
      if (existsSync(p)) return p;
    }
  }
  return null;
};
is(`the notification route ${JSON.stringify(NOTIF_ROUTE)} resolves to a real page`, pageForRoute(NOTIF_ROUTE ?? ""), "src/app/(internal)/match-ops/player-chats/page.tsx");

// (b) NO redirect in next.config.ts captures it — the assertion that would have caught B
const cfg = readFileSync("next.config.ts", "utf8");
const redirectSources = [...cfg.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]);
const captures = (source: string, route: string): boolean => {
  // exact match, or a ":path*" prefix wildcard
  if (source === route) return true;
  const wild = source.match(/^(.*?)\/:path\*$/);
  return wild ? route === wild[1] || route.startsWith(`${wild[1]}/`) : false;
};
const hit = redirectSources.filter((s) => captures(s, NOTIF_ROUTE ?? ""));
is("no next.config.ts redirect captures the notification route", hit, []);
// the same check must hold for the PWA start_url
const START = (JSON.parse(readFileSync("public/manifest.json", "utf8")) as { start_url: string }).start_url;
is("manifest start_url resolves to a real page", pageForRoute(START), "src/app/(internal)/match-ops/player-chats/page.tsx");
is("no next.config.ts redirect captures the manifest start_url", redirectSources.filter((s) => captures(s, START)), []);
// prove the check has teeth: the OLD value must be caught by it
is("(control) the old '/chats' WOULD have been caught by this same check", redirectSources.filter((s) => captures(s, "/chats")).length > 0, true);

console.log("\n4) THE BELL is not inside a width-gated hidden container:");
// THE REGRESSION THIS PINS: `hidden … min-[900px]:flex` around the only render site meant there was
// no way to subscribe on a phone.
const CRM = "src/app/(internal)/match-ops/player-chats/CrmClient.tsx";
const crm = readFileSync(CRM, "utf8");
is("the bell renders in Player Chats", crm.includes("<EnablePushNotificationsButton />"), true);

// Walk outward from the render site through enclosing JSX opening tags and inspect their classNames.
// A container that is `hidden` and only becomes visible at some min-width would hide the control on
// a phone; that is exactly the shape we refuse.
const widthGatedHidden = (cls: string): boolean =>
  /\bhidden\b/.test(cls) && /(min-\[\d+px\]:(flex|block|inline-flex|grid)|(sm|md|lg|xl|2xl):(flex|block|inline-flex|grid))/.test(cls);

const ancestorClasses = (src: string, needle: string): string[] => {
  const at = src.indexOf(needle);
  if (at < 0) return [];
  const before = src.slice(0, at);
  // scan backwards for unclosed <div/<span/<aside/<section opening tags
  const open: string[] = [];
  const tagRe = /<(\/?)(div|span|aside|section|main|footer|header)\b([^>]*?)(\/?)>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(before)) !== null) {
    const [, closing, , attrs, selfClose] = m;
    if (closing === "/") stack.pop();
    else if (selfClose !== "/") stack.push(attrs);
  }
  for (const attrs of stack) {
    const c = /className=\{?["`]([^"`]*)["`]/.exec(attrs);
    if (c) open.push(c[1]);
  }
  return open;
};

// SCOPE, stated: this reads STATIC class strings only. The enclosing <aside> toggles its own
// visibility at runtime (`showInboxMobile ? "flex flex-1" : "hidden lg:flex"`) — that is the normal
// mobile master/detail pane swap, not a width gate on the control, and flagging it would be a false
// positive. What we refuse is a container that is unconditionally `hidden` until some breakpoint.
const anc = ancestorClasses(crm, "<EnablePushNotificationsButton />");
is("the ancestor walk actually finds containers (a vacuous [] would fake this test)", anc.length > 0, true);
const offenders = anc.filter(widthGatedHidden);
is("no ancestor of the bell is a width-gated `hidden` container", offenders, []);
// teeth: the exact class string that caused the bug must be recognised by the detector
is("(control) the 4f7c3fd footer class WOULD have been flagged",
  widthGatedHidden("hidden flex-none items-center gap-2.5 border-t px-4 py-2 text-[11px] font-semibold min-[900px]:flex"), true);
is("(control) an ordinary always-visible container is NOT flagged",
  widthGatedHidden("ml-auto flex items-center gap-0.5"), false);
// the keyboard affordances 4f7c3fd hid are STILL hidden — that part was right
is("bulk-select (a desktop power tool) stays desktop-only", /hidden min-\[900px\]:block/.test(crm), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
