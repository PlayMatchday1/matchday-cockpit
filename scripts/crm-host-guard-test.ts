import "server-only"; // no-op under --conditions=react-server
// Phase 19 Step 1 — the CRM outbound-host guard. Same discipline as the MatchDay host guard:
// an EXACT parsed-host match, so the classic prefix-bypass (graph.facebook.com.evil.com) and the
// userinfo trick (graph.facebook.com@evil.com) are rejected. Mutation tests give it teeth: a
// startsWith-based "guard" must FAIL the evil cases while the real one passes.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/crm-host-guard-test.ts
import { assertAllowedOutboundHost, OutboundHostError, CRM_ALLOWED_HOSTS } from "../src/lib/crmHostGuard";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const allows = (url: string) => { try { assertAllowedOutboundHost(url); return true; } catch { return false; } };

// ── allow the two real hosts ──
allows("https://graph.facebook.com/v21.0/123/messages") ? ok("WhatsApp host graph.facebook.com is allowed") : bad("graph.facebook.com rejected");
allows("https://api.telnyx.com/v2/messages") ? ok("Telnyx host api.telnyx.com is allowed") : bad("api.telnyx.com rejected");

// ── reject the bypass classics ──
!allows("https://graph.facebook.com.evil.com/v21.0/x/messages") ? ok("REJECT prefix trick: graph.facebook.com.evil.com") : bad("prefix trick allowed");
!allows("https://graph.facebook.com@evil.com/v21.0/x/messages") ? ok("REJECT userinfo trick: graph.facebook.com@evil.com → host evil.com") : bad("userinfo trick allowed");
!allows("https://evil.graph.facebook.com/x") ? ok("REJECT lookalike subdomain: evil.graph.facebook.com") : bad("lookalike subdomain allowed");
!allows("https://evil.com/graph.facebook.com/messages") ? ok("REJECT path spoof: evil.com/graph.facebook.com") : bad("path spoof allowed");
!allows("http://graph.facebook.com:8080/x") ? ok("REJECT non-default port: graph.facebook.com:8080") : bad("port variant allowed");
!allows("not-a-url") ? ok("REJECT an unparseable URL") : bad("unparseable allowed");
!allows("https://telnyx.com.evil.com/x") ? ok("REJECT telnyx prefix trick: telnyx.com.evil.com") : bad("telnyx prefix trick allowed");

// ── the error carries the offending host ──
try { assertAllowedOutboundHost("https://graph.facebook.com.evil.com/x"); bad("should have thrown"); }
catch (e) { (e instanceof OutboundHostError && e.host === "graph.facebook.com.evil.com") ? ok("OutboundHostError names the offending host") : bad("error shape", String(e)); }

// ── the allowlist is exactly the two hosts (documented) ──
JSON.stringify([...CRM_ALLOWED_HOSTS].sort()) === JSON.stringify(["api.telnyx.com", "graph.facebook.com"])
  ? ok("allowlist is exactly graph.facebook.com + api.telnyx.com") : bad("allowlist changed", JSON.stringify(CRM_ALLOWED_HOSTS));

// ── MUTATION: a prefix-based guard passes the good URL but WAVES THROUGH the evil one ──
function mutation(name: string, real: (u: string) => boolean, broken: (u: string) => boolean, probe: (fn: (u: string) => boolean) => boolean) {
  let r = false, b = true;
  try { r = probe(real); } catch { r = false; }
  try { b = probe(broken); } catch { b = false; }
  (r && !b) ? ok(`${name}: real PASSES, broken FAILS (teeth)`) : bad(name, `real=${r} broken=${b}`);
}
const prefixGuardAllows = (u: string) => u.startsWith("https://graph.facebook.com") || u.startsWith("https://api.telnyx.com");
mutation("exact-host match beats a startsWith prefix check", allows, prefixGuardAllows,
  (fn) => fn("https://graph.facebook.com/v21.0/x/messages") === true && fn("https://graph.facebook.com.evil.com/x") === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
