/* STAFF SIGN-IN CODES BY TEXT: what may be sent, and what may be stored.
 *
 * 1. telnyx_sms_log never holds a sign-in code: the exact template is replaced in message_body AND in
 *    the raw message, and a NORMAL message is stored in full (the presence control, Ryan 2026-10-29).
 * 2. The Send SMS hook's gate: staff numbers only, 30 second cooldown, 5 an hour.
 * 3. The hook only believes a correctly signed request.
 * The last block is two source assertions, narrowed to the pairing, because the ingest's row and the
 * hook's order of operations sit behind a database and are not observable inside the gate. */
import { readFileSync } from "node:fs";
import { signInCodeText, isSignInCodeText, redactForLog, SIGN_IN_CODE_REDACTED, smsGate, CODES_PER_HOUR, isFictionalTestNumber } from "@/lib/signInCode";
import { signStandardWebhook, verifyStandardWebhook } from "@/lib/standardWebhook";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

console.log("\nthe template and the pattern agree");
const sent = signInCodeText("482913");
yes("the text the hook sends is recognised", isSignInCodeText(sent), sent);
yes("…for any six digits", isSignInCodeText(signInCodeText("000001")));
yes("CONTROL: a player message that mentions a code is not", !isSignInCodeText("Your promo code is 482913, see you Thursday"));
yes("CONTROL: the template with five digits is not", !isSignInCodeText("Your MatchDay Clubhouse sign-in code is 48291. Do not share it."));
yes("CONTROL: the template with extra text after it is not", !isSignInCodeText(`${sent} Reply STOP`));

console.log("\ntelnyx_sms_log stores the placeholder for a code, and a normal message in full");
const codeMsg = { id: "m1", text: sent, to: [{ phone_number: "+15125550123" }] };
const r1 = redactForLog(codeMsg.text, codeMsg);
is("a code's body becomes the placeholder", r1.body, SIGN_IN_CODE_REDACTED);
is("…and so does the raw message's text", r1.msg.text, SIGN_IN_CODE_REDACTED);
yes("…and the code appears nowhere in what is stored", !JSON.stringify(r1).includes("482913"), JSON.stringify(r1));
yes("…while the rest of the raw message is kept", r1.msg.id === "m1" && r1.msg.to[0].phone_number === "+15125550123");
const normal = { id: "m2", text: "Your match at Field 12 starts at 7:00 PM. See you there!" };
const r2 = redactForLog(normal.text, normal);
is("PRESENCE CONTROL: a normal message's body is stored in full", r2.body, normal.text);
is("PRESENCE CONTROL: …and its raw text too", r2.msg.text, normal.text);
yes("PRESENCE CONTROL: …as the same object, untouched", r2.msg === normal);
is("a message with no text stays empty", redactForLog(null, { id: "m3" }).body, null);
// Telnyx returns the words twice, as text and original_text (2026-10-30): both are replaced.
const twice = { id: "m4", text: sent, original_text: sent, to: [{ phone_number: "+15125550123" }] };
const r4 = redactForLog(twice.text, twice);
is("original_text is replaced too", r4.msg.original_text, SIGN_IN_CODE_REDACTED);
yes("…and the code appears nowhere in what is stored", !JSON.stringify(r4).includes("482913"), JSON.stringify(r4));
yes("…while the rest of the raw message is kept", r4.msg.id === "m4" && r4.msg.to[0].phone_number === "+15125550123");

console.log("\nthe hook's gate");
const now = new Date("2026-10-29T20:00:00.000Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);
is("a staff number with no recent requests is sent", smsGate(true, [], now), { send: true });
is("a number on no staff account is refused", smsGate(false, [], now).send, false);
is("…as not_staff, whatever its history", (smsGate(false, [], now) as { reason: string }).reason, "not_staff");
is("a request 10 seconds after the last is refused (cooldown)", (smsGate(true, [ago(10)], now) as { reason: string }).reason, "cooldown");
is("CONTROL: 31 seconds after the last is sent", smsGate(true, [ago(31)], now), { send: true });
const five = [ago(3000), ago(2500), ago(2000), ago(1500), ago(60)];
is(`the ${CODES_PER_HOUR + 1}th request inside an hour is refused (hourly limit)`, (smsGate(true, five, now) as { reason: string }).reason, "hourly_limit");
is("CONTROL: four inside the hour, the fifth is sent", smsGate(true, five.slice(1), now), { send: true });
is("CONTROL: requests older than an hour do not count", smsGate(true, [ago(3700), ago(3800), ago(3900), ago(4000), ago(4100)], now), { send: true });

console.log("\nthe hook believes only a signed request");
const secret = `v1,whsec_${Buffer.from("a-test-secret-of-some-length!!").toString("base64")}`;
const body = JSON.stringify({ user: { phone: "15125550123" }, sms: { otp: "482913" } });
const t = Math.floor(now.getTime() / 1000);
const sig = signStandardWebhook(secret, "msg_1", t, body);
yes("a correctly signed request verifies", verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(t), signature: sig }, body, t));
yes("…among several signatures", verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(t), signature: `v1,AAAA ${sig}` }, body, t));
yes("a changed body does not", !verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(t), signature: sig }, body.replace("482913", "111111"), t));
yes("the wrong secret does not", !verifyStandardWebhook(`v1,whsec_${Buffer.from("another").toString("base64")}`, { id: "msg_1", timestamp: String(t), signature: sig }, body, t));
yes("a request more than five minutes old does not", !verifyStandardWebhook(secret, { id: "msg_1", timestamp: String(t), signature: sig }, body, t + 301));
yes("no secret configured does not", !verifyStandardWebhook("", { id: "msg_1", timestamp: String(t), signature: sig }, body, t));
yes("missing headers do not", !verifyStandardWebhook(secret, { id: null, timestamp: String(t), signature: sig }, body, t));

console.log("\nthe pairings that sit behind the database (source)");
const ingest = readFileSync("src/lib/telnyxSmsIngest.ts", "utf8");
yes("the ingest stores the redacted raw message", /raw: \{ mdr, message: red\.msg \}/.test(ingest));
yes("…and never the unredacted one", !/raw: \{ mdr, message: msg \}/.test(ingest));
yes("…and its body comes from the redaction", /const body = red\.body;/.test(ingest));
const hook = readFileSync("src/app/api/auth/sms-hook/route.ts", "utf8");
const recordAt = hook.indexOf('from("app_sms_code_requests").insert'), gateAt = hook.indexOf("smsGate("), sendAt = hook.indexOf("messages.send(");
yes("the hook records the request before it decides", recordAt > 0 && recordAt < gateAt, `${recordAt} ${gateAt}`);
yes("…and decides before it sends", gateAt > 0 && gateAt < sendAt, `${gateAt} ${sendAt}`);
yes("…and verifies the signature before anything else", hook.indexOf("verifyStandardWebhook(") < hook.indexOf('from("app_users")'));
yes("…and sends the template, not a hand-written text", /text: signInCodeText\(otp\)/.test(hook));

console.log("\n4. fictional test numbers: let through without a text, only on a staff row");
is("555 0100 is a fictional test number", isFictionalTestNumber("+15555550100"), true);
is("555 0199 is too", isFictionalTestNumber("+15125550199"), true);
is("presence control: a real-looking number is not", isFictionalTestNumber("+15125550200"), false);
is("a non-US number is not", isFictionalTestNumber("+445555550100"), false);
yes("the hook still looks the number up on app_users before allowing a test number", hook.indexOf('from("app_users")') < hook.indexOf("if (fictional)"));
yes("the hook still applies the rate gate before allowing a test number", hook.indexOf("if (!gate.send)") < hook.indexOf("if (fictional)"));
yes("a test number is answered before Telnyx is touched", hook.indexOf("if (fictional)") < hook.indexOf("new Telnyx("));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
