/* MATCH CHAT, AS THE STAFF APP READS IT (src/lib/matchChats.ts messageOut). Ryan, 2026-11-05.
 * The player app's rules (MatchDay 1.87 src/components/chat: messageEdits, reactions, replies) are
 * asserted here on the stored shapes: a marker counts only when it names its own document, because
 * older app versions copy every field of the newest message into the next photo or video they
 * send. Pure, offline; every refusal has a presence control beside it. */
import { DELETED_TEXT, firestoreChatId, messageOut, replyPreviewFor, type FirestoreMessage } from "../src/lib/matchChats";

let pass = 0, fail = 0;
const ok = (m: string) => { pass++; console.log(`  ok  ${m}`); };
const bad = (m: string, d = "") => { fail++; console.log(`  XX  ${m} ${d}`); };
const is = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const at = { seconds: 1762369200, nanoseconds: 0 };
const player = (over: Partial<FirestoreMessage> = {}): FirestoreMessage => ({
  _id: "abc", text: "See you at 7", messageType: "Text", sentBy: "Marvin", sentTo: "Group",
  user: { _id: 4307, name: "Marvin", avatar: "https://x/y.jpg", email: "m@x.com", phoneNumber: "+15125550100" }, createdAt: at, ...over,
});
const staff = (over: Partial<FirestoreMessage> = {}): FirestoreMessage => player({ _id: "u-1", text: "Gates open at 6:45", sentBy: "MatchDay", user: { _id: 9999999999, name: "MatchDay", avatar: "https://www.playmatchday.com/icon.jpg", email: "", phoneNumber: "" }, ...over });

console.log("\nthe chat document per environment");
is("staging chats carry the player app's prefix", firestoreChatId("staging", "2833"), "staging_2833");
is("production chats are the bare match id", firestoreChatId("production", "2833"), "2833");

console.log("\na plain text message");
const t = messageOut("d1", player());
is("the document id is the message id", t.id, "d1");
is("the stored _id travels too", t.messageId, "abc");
is("a player is not MatchDay", t.isMatchDay, false);
is("a MatchDay message is MatchDay", messageOut("d2", staff()).isMatchDay, true);
is("the user block carries id, name and avatar only", Object.keys(t.user), ["id", "name", "avatar"]);
is("email and phone are not passed on", JSON.stringify(t).includes("5125550100") || JSON.stringify(t).includes("m@x.com"), false);
is("the sent time is ISO", t.sentAt, "2025-11-05T19:00:00.000Z");
is("no reply, no reactions, not edited, not deleted", [t.replyTo, t.reactions, t.edited, t.deleted], [null, [], false, false]);
is("the old placeholder avatar counts as none", messageOut("d1", player({ user: { _id: 1, name: "A", avatar: "https://firebasestorage/Placeholder.png?x" } })).user.avatar, null);

console.log("\nmedia");
const photo = messageOut("p1", player({ text: null, messageType: "image/jpeg", image: "https://x/p.jpg", media: { type: "image/jpeg", url: "https://x/p.jpg", fileName: "p.jpg" } }));
is("a photo's url is imageUrl and media.url", [photo.imageUrl, photo.media?.url, photo.kind], ["https://x/p.jpg", "https://x/p.jpg", "image/jpeg"]);
const video = messageOut("v1", player({ text: null, messageType: "video/mp4", image: "https://x/thumb.jpg", media: { type: "video/mp4", url: "https://x/v.mp4", thumbnailUrl: "https://x/thumb.jpg", duration: 12.4 } }));
is("a video is not an image, keeps its thumbnail and duration", [video.imageUrl, video.media?.thumbnailUrl, video.media?.duration], [null, "https://x/thumb.jpg", 12.4]);
is("legacy image field alone is still a photo", messageOut("p2", player({ text: null, messageType: "image/png", image: "https://x/legacy.png" })).imageUrl, "https://x/legacy.png");

console.log("\nreplies (replies.ts): the snapshot counts only with its own marker");
const quote = { docId: "q1", userId: 4307, name: "Marvin", preview: "See you at 7", messageType: "Text" };
is("a reply carries its quote", messageOut("r1", staff({ replyTo: quote, replyOf: "r1" })).replyTo, quote);
is("a copied quote (marker names another document) is dropped", messageOut("r2", staff({ replyTo: quote, replyOf: "r1" })).replyTo, null);
is("a quote without a marker is dropped", messageOut("r3", staff({ replyTo: quote })).replyTo, null);
is("a blanked preview stays blank (the original was deleted)", messageOut("r4", staff({ replyTo: { ...quote, preview: "" }, replyOf: "r4" })).replyTo?.preview, "");
is("the preview rule: 90 characters, one line", replyPreviewFor({ text: `${"a".repeat(100)}\n b`, messageType: "Text" }).length, 90);
is("a photo quotes as Photo, a video as Video", [replyPreviewFor({ text: null, messageType: "image/jpeg" }), replyPreviewFor({ text: "", messageType: "video/mp4" })], ["Photo", "Video"]);

console.log("\nreactions (reactions.ts): counts per key, picker order, own marker only");
const rx = { fire: [1, 2, 3], md: [9999999999], eyes: [], joy: [4] };
is("counts in picker order", messageOut("m1", player({ reactions: rx, reactionsOf: "m1" })).reactions, [{ key: "md", count: 1 }, { key: "fire", count: 3 }, { key: "joy", count: 1 }]);
is("copied reactions are not this message's", messageOut("m2", player({ reactions: rx, reactionsOf: "m1" })).reactions, []);
is("an unknown key from a newer app is left out, the known ones stay", messageOut("m3", player({ reactions: { zzz: [1], ball: [2] }, reactionsOf: "m3" })).reactions, [{ key: "ball", count: 1 }]);

console.log("\nedits and deletes (messageEdits.ts)");
is("edited with its own marker", messageOut("e1", player({ editedAt: at, editedOf: "e1" })).edited, true);
is("a copied editedAt is not an edit", messageOut("e2", player({ editedAt: at, editedOf: "e1" })).edited, false);
const del = messageOut("x1", player({ text: DELETED_TEXT, deletedAt: at, deletedBy: "4307", deletedOf: "x1" }));
is("deleted with its own marker", del.deleted, true);
is("the deleted text is the 1.85 line", del.text, "This message was deleted");
is("a copied deletedAt is a normal message", messageOut("x2", player({ deletedAt: at, deletedOf: "x1" })).deleted, false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
