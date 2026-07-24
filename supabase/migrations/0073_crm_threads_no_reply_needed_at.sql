-- Manual "Done · no reply needed" dismissal for the Chats inbox.
--
-- The awaiting-reply queue over-counts: a closing courtesy ("Thank you",
-- "Okay thanks", 👍) is inbound-last but needs no reply. A conservative
-- heuristic (src/lib/awaitingReply.ts) suppresses the obvious cases, and
-- this column lets an operator clear anything the heuristic misses
-- WITHOUT sending a reply or fully closing the thread.
--
--   no_reply_needed_at — when an operator marked the thread "no reply
--                        needed". The thread leaves the Awaiting queue
--                        (into a muted "Wrapping up" state) while this
--                        timestamp is >= last_message_at. A NEW inbound
--                        advances last_message_at past it, so the
--                        dismissal auto-expires and the thread re-enters
--                        Awaiting — the customer said something new.
--                        "Reply anyway" clears it back to null.
--
-- Compared against last_message_at rather than being a bare boolean
-- precisely so a fresh customer message can never stay silently
-- dismissed. Mirrors the crm_thread_reads last_read_at-vs-last_message_at
-- pattern already used for unread state.
--
-- Apply via Supabase Dashboard → SQL Editor.

ALTER TABLE crm_threads
  ADD COLUMN IF NOT EXISTS no_reply_needed_at timestamptz;

-- No backfill: no thread has been dismissed yet (stays null = still
-- governed purely by direction + the acknowledgment heuristic).
