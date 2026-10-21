import "server-only"; // no-op under --conditions=react-server
// LINK A PLAYER CHATS THREAD TO AN ACCOUNT — the one action that changes who every message on a
// phone number is attributed to, and so what the context pane and Claude's drafts say about them.
//
// A person does it, never the webhook and never a draft: the card's "Matches Sam, link?" and the
// context pane's "Link to account" / "Change account" both end here. It sets crm_threads.player_id
// and account_confirmed_at / account_confirmed_by_user_id (migration 0228), then supersedes any
// pending draft so the next one is written from the right account.
//
// RECORDED THROUGH recordWrite, three round trips: read the thread, write, read it back. LANDED
// means the read-back shows the new account; a 2xx alone is not that. The change log carries who,
// when, the account before and the account after. Player ids only, no names or phones.
//
// The webhooks never overwrite a link: they patch player_id only while it is null
// (src/app/api/whatsapp/webhook/route.ts and src/app/api/webhooks/telnyx/route.ts).

import { randomUUID } from "node:crypto";
import { recordWrite, supabaseLogStore, type LogStore } from "@/lib/changeLog";
import { resolveCityScope } from "@/lib/cityScope";

type ThreadLinkState = { player_id: number | null; account_confirmed_at: string | null; account_confirmed_by_user_id: string | null };

export type LinkIO = {
  readThread: () => Promise<ThreadLinkState | null>;
  readTarget: (playerId: number) => Promise<{ id: number; first_name: string | null; preferable_city_normalized: string | null } | null>;
  writeThread: (patch: { player_id: number; account_confirmed_at: string; account_confirmed_by_user_id: string | null }) => Promise<void>;
  supersedePendingDrafts: () => Promise<void>;
  now: () => string;
};

export type LinkArgs = {
  threadId: string;
  playerId: number;
  actor: { appUserId: string | null; email: string | null };
  confinedCity: string | null;
};

export type LinkResult =
  | { ok: true; outcome: string; logged: boolean; action: "link" | "change" | "confirm"; from_player_id: number | null; to_player_id: number; first_name: string | null }
  | { ok: false; status: number; error: string };

export async function linkThread(args: LinkArgs, io: LinkIO, store: LogStore = supabaseLogStore()): Promise<LinkResult> {
  const before = await io.readThread();
  if (!before) return { ok: false, status: 404, error: "Thread not found." };
  const target = await io.readTarget(args.playerId);
  if (!target) return { ok: false, status: 404, error: "No account with that id." };
  // THE CITY BOUNDARY. A confined account can only link to a player in its own city: linking is
  // how the pane and the drafts come to show that player's account.
  if (args.confinedCity && resolveCityScope(target.preferable_city_normalized)?.identifier !== args.confinedCity) {
    return { ok: false, status: 403, error: "That player is outside your city." };
  }
  const action = before.player_id == null ? "link" : before.player_id === args.playerId ? "confirm" : "change";
  const at = io.now();
  const res = await recordWrite(
    {
      env: "production", source: "crm-link",
      actorName: args.actor.email ?? args.actor.appUserId ?? "unknown",
      actorEmail: args.actor.email,
      saveId: randomUUID(),
      matchId: null, matchName: null,
      method: "POST", path: `/api/crm/threads/${args.threadId}/link`,
      body: { thread_id: args.threadId, action, from_player_id: before.player_id, to_player_id: args.playerId },
      keys: [], label: (k) => k,
      applied: (_b, after) => after.player_id === args.playerId && after.account_confirmed_at != null,
      changes: [{ key: "player_id", field: "Linked account", before: before.player_id == null ? "none" : `player ${before.player_id}`, after: `player ${args.playerId}` }],
    },
    {
      readResource: async () => ((await io.readThread()) ?? {}) as Record<string, unknown>,
      write: async () => io.writeThread({ player_id: args.playerId, account_confirmed_at: at, account_confirmed_by_user_id: args.actor.appUserId }),
      now: () => at,
    },
    store,
  );
  if (res.error) return { ok: false, status: 500, error: "The link didn't save." };
  // The stored draft was written for the old account (or for no account). Supersede it so the
  // card drafts again from the one just linked.
  await io.supersedePendingDrafts().catch(() => {});
  return { ok: true, outcome: res.outcome, logged: res.logged, action, from_player_id: before.player_id, to_player_id: args.playerId, first_name: target.first_name };
}
