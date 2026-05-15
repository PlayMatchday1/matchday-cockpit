# CRM MVP (Phase 0) — end-to-end test guide

This is the Phase 0 proof-of-concept for a two-way SMS customer-service
loop. Single page at `/crm`, corp-only (`app_users.is_admin = true`).
Backed by Telnyx for SMS, Supabase for storage + realtime.

> **Scope.** Phase 0 only. No assignment, no role scoping, no City
> Manager accounts, no Stripe display, no quick replies, no internal
> notes. Add those in Phase 1 once we know this loop works.

---

## What ships in this build

| Piece                                | Path                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| DB migration                         | `supabase/migrations/0029_crm_mvp.sql`                               |
| Phone normalization helper           | `src/lib/phone.ts` (+ `phone.test.ts`)                               |
| Shared CRM auth                      | `src/lib/crmAuth.ts`                                                 |
| Telnyx inbound webhook (Ed25519)     | `src/app/api/webhooks/telnyx/route.ts`                               |
| Outbound send route                  | `src/app/api/crm/send/route.ts`                                      |
| Thread list / detail reads           | `src/app/api/crm/threads/route.ts`, `.../[id]/route.ts`              |
| Three-pane CRM page                  | `src/app/(internal)/crm/page.tsx`, `CrmClient.tsx`                   |
| Top nav link (admin dropdown)        | `src/components/TopNav.tsx`                                          |

---

## Required env vars (Vercel → Production)

Add these to Vercel before merging. Order matches the test plan below.

| Variable                       | Where it comes from                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELNYX_API_KEY`               | Mission Control → API Keys. Used to authenticate outbound `messages.send`.                                                                                                         |
| `TELNYX_PUBLIC_KEY`            | Mission Control → API Keys → "Public Key" (base64 Ed25519 key). Used to verify inbound webhook signatures. **Without this set, the webhook returns 500 and inbound SMS is lost.** |
| `TELNYX_FROM_NUMBER`           | The new test number in E.164 (e.g. `+15125550123`). The Messages API uses this as the `from` for every outbound.                                                                   |
| `TELNYX_MESSAGING_PROFILE_ID`  | *Not currently read.* Reserved — only needed if we later switch to number-pool sending.                                                                                            |

> The Supabase env vars (`NEXT_PUBLIC_SUPABASE_URL`,
> `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
> `CRON_SECRET`) are already in production for the rest of the cockpit.

---

## Telnyx setup (one-time per number)

### 1. Buy the test number

1. Mission Control → Numbers → Search & Buy a Number.
2. Pick a local US long-code. (10DLC compatibility — short codes and
   toll-free have different rules.)

### 2. Attach to the existing 10DLC campaign

Telnyx will not deliver A2P messages from an unregistered number.

1. Mission Control → Messaging → 10DLC → your existing campaign.
2. **Phone Numbers** tab → **Assign Numbers** → pick the new number.
3. Wait for assignment to show `active`. (Usually instant; up to a few
   minutes.)

> Skip the brand/campaign registration steps — those already exist for
> the automated-SMS number and this phone is being attached to the same
> campaign.

### 3. Wire up the Messaging Profile webhook

The webhook is what Telnyx calls when an inbound SMS arrives.

1. Mission Control → Messaging → Messaging Profiles.
2. Open the profile attached to the test number.
3. **Inbound Settings**:
    - **Webhook URL** → `https://<your-prod-host>/api/webhooks/telnyx`
    - **Webhook Failover URL** → leave blank for MVP.
    - **Webhook API Version** → `2`.
4. Save.

### 4. Confirm signature verification keys

1. Mission Control → Account → API Keys.
2. Copy the **Public Key** (base64-encoded Ed25519). This is
   `TELNYX_PUBLIC_KEY`.
3. Copy an active **API Key**. This is `TELNYX_API_KEY`.
4. `vercel env add TELNYX_PUBLIC_KEY production` and
   `vercel env add TELNYX_API_KEY production`, then redeploy.

---

## End-to-end test (after migration applied + env vars in place)

1. **Open the page.** Visit `https://<prod>/crm`. You must be signed
   in as a user with `app_users.is_admin = true`.
    - On first load: thread list is empty, center pane shows "Select a
      conversation," right pane shows "No player selected."
2. **Send an inbound from your own phone.** Text any short message
   ("test 1") to the new Telnyx number from your personal phone.
3. **Watch the webhook.** In Vercel → Functions logs, you should see:
    ```
    [crm:webhook] hit event=message.received id=<uuid>
    [crm:webhook] stored phone=+1... player_id=<id or -> ambiguous=false candidates=N elapsed=Xms
    ```
    If you see `signature verification failed`, `TELNYX_PUBLIC_KEY` is
    wrong. If you see `dropped: bad-phone`, libphonenumber rejected the
    inbound (rare for real US phones).
4. **See it appear in the UI.** The thread list should pick up the
   new conversation within ~1 second via Supabase realtime. If realtime
   shows "offline (refresh manually)" in the header, click Refresh.
5. **Send a reply.** Click the thread → type a reply → hit Enter.
    - Check Vercel logs for `[crm:send] done ... segments=1 ...`.
    - Your phone should receive the outbound SMS from the test number.
6. **Verify the player context** (right pane):
    - If your phone matches a `mdapi_users.phone_number` (E.164 or
      10-digit), the right pane shows that player's name / city / email
      / total matches.
    - Otherwise: "Unknown number — search to link" placeholder.
7. **Test the ambiguous flag.** Pick a phone number that exists on
   multiple `mdapi_users` rows (the investigation script found ≥3 in
   the first 1k rows). Send an inbound from that number. The thread
   row should show an "ambiguous" pill in the left list and a rust
   warning bar in the right pane.

---

## Things you'll see in the logs for the first week

Every webhook hit and every send is logged to console (per spec). Grep
`[crm:` in Vercel logs.

- `[crm:webhook] hit event=<type> id=<event-id>` — every Telnyx webhook
  (not just inbound — DLRs and status updates land here too and are
  silently 200'd).
- `[crm:webhook] stored phone=… player_id=… ambiguous=… candidates=N` —
  successful inbound persisted.
- `[crm:webhook] dropped: bad-phone` — phone failed libphonenumber's
  `isValidNumber`. 200 returned to Telnyx so they don't retry.
- `[crm:webhook] dedupe: telnyx_message_id=… already stored` — Telnyx
  replayed an inbound. The partial-unique index on
  `crm_messages.telnyx_message_id` absorbs it.
- `[crm:send] start thread=… to=… user=… bytes=…` — operator hit Send.
- `[crm:send] done thread=… telnyx_id=… segments=… elapsed=…ms` —
  Telnyx accepted the outbound. `segments` comes from the API
  response's `parts` field.
- `[crm:send] done … ERROR=…` — Telnyx rejected the send. The
  `crm_messages` row was still inserted (with `telnyx_message_id=null`)
  so the operator sees their attempt in the UI; the bubble shows "not
  delivered".

---

## Limitations / known follow-ups

- **No write to `mdapi_users`.** We never normalize that table; both
  E.164 and 10-digit shapes coexist there. The matcher tries E.164
  first, then 10-digit national, oldest-`created_at` wins on ties.
- **`match_ambiguous` is sticky.** Once true, it stays true even if
  later messages from the same number only match one user. There's no
  UI to clear it in Phase 0.
- **No assignee / read state.** Unread dots are localStorage-only and
  per-browser.
- **No phone-search-to-link UI** for unknown numbers — placeholder
  only. A user-search component will land in Phase 1.
- **No delivery-receipt tracking.** Telnyx sends `message.finalized` /
  `message.failed` webhooks; we currently 200-and-ignore them. Phase 1
  should track delivery status on `crm_messages`.
- **No outbound retry.** If Telnyx fails the send, we don't retry —
  the operator sees "not delivered" and can resend manually.

---

## Reverting

If something goes sideways, the safest backout is:

1. Remove `TELNYX_PUBLIC_KEY` from Vercel — inbound webhook 500s and
   does nothing.
2. Remove the Messaging Profile webhook URL on Telnyx.
3. The `crm_*` tables can stay; they're isolated.
