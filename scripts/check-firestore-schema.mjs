// Phase 3 Match Chats — read-only Firestore schema probe.
//
// Run (either works):
//   node scripts/check-firestore-schema.mjs
//   node --env-file=.env.local scripts/check-firestore-schema.mjs
//
// Credential lookup, in order:
//   1. ./firebase-service-account.json (gitignored, local-only)
//   2. FIREBASE_SERVICE_ACCOUNT_JSON env var (string)
//
// Production reads the env var. Locally the JSON file is preferred
// because the Vercel env var is marked "Sensitive" and pulls as an
// empty string.
//
// What it does (read-only — NO writes to Firestore):
//   1. Initializes firebase-admin from the resolved credentials.
//   2. Lists all top-level collections.
//   3. For each collection whose name plausibly relates to chats /
//      matches / messages, prints the document field shape from
//      three sample docs (ordered by likely "recent activity"
//      timestamp if one of the usual fields works).
//   4. Probes for subcollections under the first doc of each
//      candidate collection (the matches/{id}/messages pattern is
//      common in mobile chat apps).
//   5. Picks the most-recently-active match (whichever ordering
//      strategy succeeded) and dumps 10 sample messages from its
//      messages subcollection to show the per-message shape.
//   6. Heuristically redacts likely-PII strings (emails, phones,
//      long free-text bodies) before printing.
//
// Output goes to stdout; nothing is written to disk. If a query fails
// (missing composite index, permission), we log and continue.

import admin from "firebase-admin";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const LOCAL_KEY_PATH = resolve(process.cwd(), "firebase-service-account.json");

let raw = null;
let source = null;
if (existsSync(LOCAL_KEY_PATH)) {
  raw = readFileSync(LOCAL_KEY_PATH, "utf8");
  source = LOCAL_KEY_PATH;
} else if (
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().length > 0
) {
  raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  source = "env:FIREBASE_SERVICE_ACCOUNT_JSON";
}

if (!raw) {
  console.error(
    "No Firebase credentials found.\n" +
      "  Expected one of:\n" +
      `    file: ${LOCAL_KEY_PATH}\n` +
      "    env:  FIREBASE_SERVICE_ACCOUNT_JSON (note: Sensitive vars pull as empty)",
  );
  process.exit(1);
}

let creds;
try {
  creds = JSON.parse(raw);
} catch (e) {
  console.error(`Credentials from ${source} did not parse as JSON:`, e.message);
  process.exit(1);
}

if (!creds.project_id || !creds.client_email || !creds.private_key) {
  console.error(
    "Service account JSON is missing required fields (project_id / client_email / private_key).",
  );
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(creds) });
const db = admin.firestore();

console.log(`Credential source: ${source}`);
console.log(`Firebase project:  ${creds.project_id}`);
console.log(`Service account:   ${creds.client_email}\n`);

// ---------------------------------------------------------------
// 1) Top-level collections
// ---------------------------------------------------------------
console.log("=== Top-level collections ===");
const rootCols = await db.listCollections();
const rootNames = rootCols.map((c) => c.id);
for (const id of rootNames) console.log(`  - ${id}`);
if (rootNames.length === 0) {
  console.log("  (none)");
  await admin.app().delete();
  process.exit(0);
}

// ---------------------------------------------------------------
// 2) Pick chat-candidate collections
// ---------------------------------------------------------------
const CHAT_KEYWORDS = [
  "chat",
  "message",
  "conversation",
  "match",
  "thread",
  "room",
];
const candidates = rootNames.filter((n) =>
  CHAT_KEYWORDS.some((k) => n.toLowerCase().includes(k)),
);

if (candidates.length === 0) {
  console.log(
    "\n(No collection name hinted at chats/messages/matches. Falling back to all top-level collections.)",
  );
  candidates.push(...rootNames);
}

// Common "recent activity" timestamp fields to try.
const TS_CANDIDATES = [
  "lastMessageAt",
  "updatedAt",
  "lastActivityAt",
  "modifiedAt",
  "createdAt",
  "timestamp",
];

const collectionFindings = []; // for later "pick most recent" pass

for (const name of candidates) {
  console.log(`\n=== ${name} — sample of 3 ===`);
  const col = db.collection(name);

  // First try a normal sorted .get() so we get fields. If it comes
  // back empty, fall back to listDocuments() which returns phantom
  // docs (those that only carry subcollections, with no top-level
  // fields — a common pattern in chat apps where the parent doc is
  // just an ID anchor).
  let snap = null;
  let usedField = null;
  for (const f of TS_CANDIDATES) {
    try {
      const s = await col.orderBy(f, "desc").limit(3).get();
      if (!s.empty) {
        snap = s;
        usedField = f;
        break;
      }
    } catch {
      // 9 = FAILED_PRECONDITION (no index). Move on.
    }
  }
  if (!snap) {
    try {
      snap = await col.limit(3).get();
    } catch (e) {
      console.log(`  read error: ${e.code ?? ""} ${e.message ?? e}`);
      continue;
    }
  }

  let docs = snap.docs;
  let phantomMode = false;
  if (docs.length === 0) {
    // Phantom-doc fallback.
    const refs = await col.listDocuments();
    if (refs.length === 0) {
      console.log(`  (collection has zero documents)`);
      continue;
    }
    docs = refs.slice(0, 3).map((r) => ({
      id: r.id,
      ref: r,
      data: () => null,
    }));
    phantomMode = true;
    console.log(
      `  (no docs with fields — found ${refs.length} phantom parents via listDocuments)`,
    );
  } else {
    console.log(
      `  ordered by: ${usedField ?? "(none — unordered limit)"} desc`,
    );
  }

  let i = 0;
  for (const doc of docs) {
    console.log(`  [${i}] id=${doc.id}`);
    if (i === 0 && !phantomMode) {
      describeDoc(doc.data(), "      ");
    }
    i += 1;
  }

  // Probe subcollections under the first doc.
  try {
    const subs = await docs[0].ref.listCollections();
    if (subs.length > 0) {
      console.log(
        `  subcollections under ${name}/${docs[0].id}: ${subs.map((s) => s.id).join(", ")}`,
      );
    } else {
      console.log(`  subcollections: (none)`);
    }
    collectionFindings.push({
      name,
      tsField: usedField,
      firstDoc: docs[0],
      phantomMode,
      subcollections: subs.map((s) => s.id),
    });
  } catch (e) {
    console.log(`  subcollection probe failed: ${e.message ?? e}`);
  }
}

// ---------------------------------------------------------------
// 3) Dump 10 messages from the most-recently-active chat
// ---------------------------------------------------------------
// Strategy:
//   a) If a candidate had a recent-activity timestamp AND a subcollection
//      whose name contains "message", use that first doc as the chat
//      and pull 10 newest messages from its message subcollection.
//   b) Else, if any top-level collection looks like flat messages (has
//      a per-doc match/chat id), sample 10 from there.
// ---------------------------------------------------------------
console.log("\n=== Per-message sample (10) ===");

let messageSource = null;
for (const f of collectionFindings) {
  const msgSub = f.subcollections.find((s) =>
    s.toLowerCase().includes("message"),
  );
  if (msgSub) {
    messageSource = {
      mode: "nested",
      chatCol: f.name,
      chatDoc: f.firstDoc,
      messagesCol: msgSub,
    };
    break;
  }
}
if (!messageSource) {
  const flatMessages = collectionFindings.find((f) =>
    f.name.toLowerCase().includes("message"),
  );
  if (flatMessages) {
    messageSource = {
      mode: "flat",
      messagesCol: flatMessages.name,
      tsField: flatMessages.tsField,
    };
  }
}

if (!messageSource) {
  console.log(
    "  Could not identify a messages collection or subcollection. " +
      "Review the candidate listings above and update this script.",
  );
} else if (messageSource.mode === "nested") {
  const path = `${messageSource.chatCol}/${messageSource.chatDoc.id}/${messageSource.messagesCol}`;
  console.log(`  Pulling from: ${path}`);
  // Try a few common timestamp orderings on messages.
  let msgs = null;
  let used = null;
  for (const f of ["createdAt", "timestamp", "sentAt", "time"]) {
    try {
      const s = await messageSource.chatDoc.ref
        .collection(messageSource.messagesCol)
        .orderBy(f, "desc")
        .limit(10)
        .get();
      if (!s.empty) {
        msgs = s;
        used = f;
        break;
      }
    } catch {
      // missing index — try next
    }
  }
  if (!msgs) {
    msgs = await messageSource.chatDoc.ref
      .collection(messageSource.messagesCol)
      .limit(10)
      .get();
  }
  console.log(
    `  ordered by: ${used ?? "(none — unordered limit)"} desc; count=${msgs.size}`,
  );
  console.log(`  Parent chat doc shape (for context):`);
  describeDoc(messageSource.chatDoc.data(), "    ");
  console.log(`  Messages:`);
  let i = 0;
  for (const m of msgs.docs) {
    console.log(`    [${i}] id=${m.id}`);
    describeDoc(m.data(), "        ");
    i += 1;
  }
} else if (messageSource.mode === "flat") {
  console.log(`  Pulling from: ${messageSource.messagesCol} (flat)`);
  let s = null;
  let used = null;
  for (const f of [
    messageSource.tsField,
    "createdAt",
    "timestamp",
    "sentAt",
  ].filter(Boolean)) {
    try {
      const tryS = await db
        .collection(messageSource.messagesCol)
        .orderBy(f, "desc")
        .limit(10)
        .get();
      if (!tryS.empty) {
        s = tryS;
        used = f;
        break;
      }
    } catch {
      // skip
    }
  }
  if (!s) {
    s = await db.collection(messageSource.messagesCol).limit(10).get();
  }
  console.log(
    `  ordered by: ${used ?? "(none — unordered limit)"} desc; count=${s.size}`,
  );
  let i = 0;
  for (const m of s.docs) {
    console.log(`    [${i}] id=${m.id}`);
    describeDoc(m.data(), "        ");
    i += 1;
  }
}

// ---------------------------------------------------------------
// 4) Collection-group probe — finds genuinely recent activity
// ---------------------------------------------------------------
// The per-collection sample above will hit the FIRST phantom doc
// (lex-ordered), which is rarely the most active chat. For the
// production query path ("active chats in the last 7 days"), the
// right primitive is a collection-group query across every
// `messages` subcollection ordered by createdAt DESC. This also
// validates that the necessary single-field collection-group index
// exists for the production listener.
console.log("\n=== Collection-group probe: recent messages across ALL chats ===");
try {
  const cg = await db
    .collectionGroup("messages")
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  console.log(`  ordered by: createdAt desc; count=${cg.size}`);

  const byChat = new Map();
  for (const doc of cg.docs) {
    const parentChatId = doc.ref.parent.parent?.id ?? "(unknown)";
    if (!byChat.has(parentChatId)) byChat.set(parentChatId, []);
    byChat.get(parentChatId).push(doc);
  }

  console.log(
    `  Distinct active chats in top-20-message window: ${byChat.size}`,
  );
  console.log(
    `  Newest message timestamp: ${cg.docs[0]?.data().createdAt?.toDate()?.toISOString() ?? "?"}`,
  );
  console.log(
    `  Oldest message in window: ${cg.docs[cg.size - 1]?.data().createdAt?.toDate()?.toISOString() ?? "?"}`,
  );

  // Show the 5 most-recently-active chat IDs.
  const recentChatIds = [...byChat.keys()].slice(0, 5);
  console.log(`  Most recently active chat IDs: ${recentChatIds.join(", ")}`);

  // Dump 5 messages from the single most-recent chat for shape.
  const topChatId = recentChatIds[0];
  if (topChatId) {
    console.log(`\n  --- Sample from most-recently-active chat: Chats/${topChatId} ---`);
    const recent = await db
      .collection("Chats")
      .doc(topChatId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();
    let i = 0;
    for (const m of recent.docs) {
      console.log(`    [${i}] id=${m.id}`);
      describeDoc(m.data(), "        ");
      i += 1;
    }
  }
} catch (e) {
  console.log(`  collection-group probe failed`);
  console.log(`    code:    ${e.code ?? "(none)"}`);
  console.log(`    message: ${e.message ?? "(empty)"}`);
  console.log(`    details: ${e.details ?? "(none)"}`);
  console.log(`    note: ${e.note ?? "(none)"}`);
  // Firestore tunnels the index URL through metadata.
  if (e.metadata && typeof e.metadata.toJSON === "function") {
    try {
      console.log(`    metadata: ${JSON.stringify(e.metadata.toJSON())}`);
    } catch {
      console.log(`    metadata: (unserializable)`);
    }
  }
  // Last-ditch: dump every enumerable property in the error.
  const keys = Object.getOwnPropertyNames(e).filter(
    (k) => !["code", "message", "details", "note", "metadata", "stack"].includes(k),
  );
  for (const k of keys) {
    try {
      console.log(`    ${k}: ${JSON.stringify(e[k])}`);
    } catch {
      console.log(`    ${k}: ${String(e[k])}`);
    }
  }
}

// ---------------------------------------------------------------
// 5) Fallback recent-activity probe — highest-numeric chat IDs
// ---------------------------------------------------------------
// The collection-group probe needs an index that doesn't exist yet.
// As an interim, walk the chat IDs sorted numerically descending —
// they LOOK like match IDs, and match IDs are roughly monotonic, so
// the top of that list is a good proxy for "newest matches with a
// chat doc."
console.log("\n=== Numeric-id-sort probe: 5 highest-id chats ===");
try {
  const refs = await db.collection("Chats").listDocuments();
  // Keep only numeric ids (defends against any non-match docs).
  const numericIds = refs
    .map((r) => r.id)
    .filter((id) => /^\d+$/.test(id))
    .map((id) => Number(id))
    .sort((a, b) => b - a)
    .slice(0, 5);
  console.log(
    `  Total chat docs: ${refs.length}; numeric ids: ${refs.filter((r) => /^\d+$/.test(r.id)).length}`,
  );
  console.log(`  Top 5 numeric ids: ${numericIds.join(", ")}`);

  for (const id of numericIds) {
    const msgs = await db
      .collection("Chats")
      .doc(String(id))
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(3)
      .get();
    const newest = msgs.docs[0]?.data().createdAt?.toDate()?.toISOString();
    console.log(`  Chats/${id}: ${msgs.size} recent messages, newest=${newest ?? "n/a"}`);
    let i = 0;
    for (const m of msgs.docs) {
      console.log(`    [${i}] id=${m.id}`);
      describeDoc(m.data(), "        ");
      i += 1;
    }
  }
} catch (e) {
  console.log(`  fallback probe failed: ${e.code ?? ""} ${e.message ?? e}`);
}

await admin.app().delete();

// ===============================================================
// Helpers
// ===============================================================

function describeDoc(data, indent) {
  for (const [k, v] of Object.entries(data ?? {})) {
    console.log(`${indent}${k}: ${describeVal(v)}`);
  }
}

function describeVal(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") {
    return `string  ${JSON.stringify(redact(v))}`;
  }
  if (typeof v === "number") return `number  ${v}`;
  if (typeof v === "boolean") return `bool    ${v}`;
  // Firestore Timestamp objects expose toDate()
  if (v && typeof v.toDate === "function") {
    return `Timestamp  ${v.toDate().toISOString()}`;
  }
  // GeoPoint / DocumentReference / etc.
  if (v && typeof v === "object" && typeof v._latitude === "number") {
    return `GeoPoint(${v._latitude}, ${v._longitude})`;
  }
  if (v && typeof v === "object" && typeof v.path === "string" && v.id) {
    return `DocumentReference  ${v.path}`;
  }
  if (Array.isArray(v)) {
    return `array[${v.length}]  ${
      v.length > 0 ? "of " + describeVal(v[0]) : ""
    }`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    const previewKeys = keys.slice(0, 5).join(", ");
    return `object{${previewKeys}${keys.length > 5 ? ", …" : ""}}`;
  }
  return String(v);
}

function redact(s) {
  if (!s) return s;
  // Likely email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "[REDACTED email]";
  // Likely phone (E.164 or 10-digit)
  if (/^\+?[\d][\d\s\-()]{6,}$/.test(s)) return "[REDACTED phone]";
  // Looks like full name (two+ capitalized words, no spaces/punct beyond)
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(s)) {
    return "[REDACTED name]";
  }
  // Long free-text body — assume message content; truncate.
  if (s.length > 80) return s.slice(0, 40) + "…[truncated]";
  return s;
}
