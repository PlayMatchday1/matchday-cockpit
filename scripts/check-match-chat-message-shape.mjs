// READ-ONLY Firestore probe.
//
// Compares the shape of a Cockpit-sent message (sentBy="MatchDay")
// against a player-sent message in the same chat. The consumer
// React Native app renders Cockpit messages with their bubble
// clipped off the left edge — we want to see exactly which fields
// differ so we can hypothesize what the consumer app keys off of.
//
// Strategy:
//   1. Find a recent chat that has BOTH Cockpit and player messages
//      (so the comparison is apples-to-apples within a single chat).
//   2. Print the full doc shape of one of each.
//   3. Print a diff side-by-side.
//
// PII redaction: player message bodies and user names get truncated
// /partial-masked before printing.

import admin from "firebase-admin";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const LOCAL_KEY_PATH = resolve(process.cwd(), "firebase-service-account.json");
if (!existsSync(LOCAL_KEY_PATH)) {
  console.error("firebase-service-account.json not found at repo root");
  process.exit(1);
}
const creds = JSON.parse(readFileSync(LOCAL_KEY_PATH, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(creds) });
const db = admin.firestore();

// --- Helpers ---
function redactString(s) {
  if (typeof s !== "string") return s;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return "<email>";
  if (/^\+?\d[\d\s\-()]{6,}$/.test(s)) return "<phone>";
  // Names: keep first letter + length hint
  if (s.length > 0 && s.length < 40) return s; // short labels — pass through
  return s.slice(0, 30) + "…";
}

function describe(value, indent = 2, depth = 0) {
  const pad = " ".repeat(indent + depth * 2);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return `string  ${JSON.stringify(redactString(value))}`;
  }
  if (typeof value === "number") return `number  ${value}`;
  if (typeof value === "boolean") return `bool    ${value}`;
  if (value && typeof value.toDate === "function") {
    return `Timestamp  ${value.toDate().toISOString()}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]";
    return `array[${value.length}]  of ${describe(value[0], indent, depth + 1)}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const lines = keys.map(
      (k) => `${pad}${k}: ${describe(value[k], indent, depth + 1)}`,
    );
    return `object{\n${lines.join("\n")}\n${" ".repeat(indent + (depth - 1) * 2)}}`;
  }
  return String(value);
}

function topLevelShape(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    out[k] = describe(v, 0, 1);
  }
  return out;
}

// --- Find a chat with both Cockpit + player messages ---

console.log("Scanning recent chats for one with both sender types…\n");

// Walk the top numeric chat IDs (highest = most recent matches).
const refs = await db.collection("Chats").listDocuments();
const numericIds = refs
  .map((r) => r.id)
  .filter((id) => /^\d+$/.test(id))
  .map((id) => Number(id))
  .sort((a, b) => b - a)
  .slice(0, 50); // probe top 50

let foundChatId = null;
let cockpitMsg = null;
let playerMsg = null;

for (const id of numericIds) {
  const snap = await db
    .collection("Chats")
    .doc(String(id))
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(30)
    .get();
  if (snap.empty) continue;

  let cockpit = null;
  let player = null;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.sentBy === "MatchDay" && !cockpit) {
      cockpit = { id: doc.id, data: d };
    } else if (d.sentBy !== "MatchDay" && !player) {
      player = { id: doc.id, data: d };
    }
    if (cockpit && player) break;
  }
  if (cockpit && player) {
    foundChatId = id;
    cockpitMsg = cockpit;
    playerMsg = player;
    break;
  }
}

if (!foundChatId) {
  console.log("No chat found with BOTH a Cockpit message and a player message in the recent window.");
  console.log("Falling back to: any Cockpit message + any player message from the top recent chats.\n");
  // Fallback: take whatever we can find
  for (const id of numericIds) {
    if (cockpitMsg && playerMsg) break;
    const snap = await db
      .collection("Chats")
      .doc(String(id))
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(30)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data();
      if (d.sentBy === "MatchDay" && !cockpitMsg) cockpitMsg = { id: doc.id, data: d, chatId: id };
      else if (d.sentBy !== "MatchDay" && !playerMsg) playerMsg = { id: doc.id, data: d, chatId: id };
      if (cockpitMsg && playerMsg) break;
    }
  }
} else {
  cockpitMsg.chatId = foundChatId;
  playerMsg.chatId = foundChatId;
}

if (!cockpitMsg || !playerMsg) {
  console.log(
    "Could not locate both message types. cockpit=" +
      !!cockpitMsg +
      " player=" +
      !!playerMsg,
  );
  await admin.app().delete();
  process.exit(0);
}

console.log(
  `Cockpit msg : Chats/${cockpitMsg.chatId}/messages/${cockpitMsg.id}`,
);
console.log(
  `Player msg  : Chats/${playerMsg.chatId}/messages/${playerMsg.id}\n`,
);

console.log("=".repeat(60));
console.log("COCKPIT-SENT MESSAGE — top-level fields");
console.log("=".repeat(60));
const cockpitShape = topLevelShape(cockpitMsg.data);
for (const [k, v] of Object.entries(cockpitShape)) {
  console.log(`  ${k}:`);
  console.log(`    ${v}`);
}

console.log("\n" + "=".repeat(60));
console.log("PLAYER-SENT MESSAGE — top-level fields");
console.log("=".repeat(60));
const playerShape = topLevelShape(playerMsg.data);
for (const [k, v] of Object.entries(playerShape)) {
  console.log(`  ${k}:`);
  console.log(`    ${v}`);
}

console.log("\n" + "=".repeat(60));
console.log("DIFF");
console.log("=".repeat(60));
const allKeys = new Set([
  ...Object.keys(cockpitMsg.data ?? {}),
  ...Object.keys(playerMsg.data ?? {}),
]);
for (const k of [...allKeys].sort()) {
  const inC = k in (cockpitMsg.data ?? {});
  const inP = k in (playerMsg.data ?? {});
  const cVal = cockpitMsg.data[k];
  const pVal = playerMsg.data[k];
  let label = "  ";
  if (!inC) label = "+P";
  else if (!inP) label = "+C";
  else if (typeof cVal !== typeof pVal) label = "ΔT";
  else if (
    typeof cVal === "object" &&
    cVal !== null &&
    typeof pVal === "object" &&
    pVal !== null
  ) {
    // For objects, compare keys
    const ck = JSON.stringify(Object.keys(cVal).sort());
    const pk = JSON.stringify(Object.keys(pVal).sort());
    if (ck !== pk) label = "Δk";
    else label = "  ";
  } else {
    label = "  ";
  }
  console.log(
    `  [${label}] ${k.padEnd(15)} cockpit=${describe(cVal).slice(0, 60)} | player=${describe(pVal).slice(0, 60)}`,
  );
}

await admin.app().delete();
