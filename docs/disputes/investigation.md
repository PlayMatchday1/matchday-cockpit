# Membership chargebacks: what a Disputes page could show (investigation, 2026-11-13)

Read-only. No code was written for this. Every figure below cites its source. Where something could
not be measured it says **UNKNOWN** and why.

**Sources read**
- **Production backend:** `0b8908a` (= `heroku-prod/master`, 2026-11-13 12:48 Central, "Membership flow and
  member details v2"). Paths relative to `apps/api/`.
- **Local backend branch:** `feature/cancel-evidence` (`d757443`, `e209800`), on no remote.
- **Our Supabase:** read-only PostgREST with the service role.
- **Stripe:** not read; see §a.
- **Player data:** ids only in this file, no names, contact details or message text.

---

## a. Listing open disputes

**How.** Stripe's `disputes.list` (GET `/v1/disputes`) with the live secret key: read-only, paginated, filterable by
`created` and `payment_intent`. Each dispute carries:

| Need | Stripe field |
|---|---|
| amount | `amount` (cents), `currency` |
| reason | `reason`: `subscription_canceled`, `fraudulent`, `product_unacceptable`, `credit_not_processed`, `product_not_received`, `general`, `debit_not_authorized`, … |
| open or not | `status` (stripe v22 `Disputes.d.ts:237`): open = `warning_needs_response`, `needs_response`, `warning_under_review`, `under_review`; closed = `won`, `lost`, `warning_closed`, `prevented` |
| evidence due | `evidence_details.due_by` (epoch), plus `has_evidence`, `past_due`, `submission_count` |
| which charge | `charge`, `payment_intent` |

**Member.** A dispute names a payment intent, never a member. The route that works:

> dispute `payment_intent` → `stripe_member_invoices.payment_intent_id` → `md_user_id`, `md_membership_id`

- **Measured on our tables.** All **102 of 102** membership dispute debits in `fin_txn` resolve to a member this
  way, through the disputed charge's own `fin_txn` row (`kind = 'charge'`, which carries `payment_intent_id`).
- **The obvious join fails.** `stripe_member_invoices.charge_id` is **empty on all 10,652 rows** (9,413 carry a
  `payment_intent_id`). The `customer_id → stripe_customers` route reaches only 57 of the 102 (51 customers).
- **Use payment intent.**

**Where the key is.** Production has it (`STRIPE_SECRET_KEY`, read by `src/lib/stripePayments.ts` and
`src/app/api/sync/stripe-people/route.ts`). A Disputes page needs one new server route that calls `disputes.list` and
joins as above. Nothing in the Clubhouse lists disputes today. The backend does not handle dispute webhooks either:
the only "dispute" in its source is a comment (`src/core/strikes/strike-fine-payments.store.ts:15`).

**How many are open now: UNKNOWN.**
- **Why:** this machine cannot read Stripe. `STRIPE_SECRET_KEY` in `.env.local` is empty and the Stripe CLI is not
  signed in. Writing a route to ask was out of scope.
- **What our tables say instead.** `fin_txn` records each dispute's balance movement, not its status:
  - 119 membership dispute rows: 102 debits, 17 reversals (17 charges carry both, a dispute that was won and the
    money returned);
  - by month: Apr 3, May 7, Jun 3, Jul 7, Aug 3, Sep 11, Oct 6, Nov 5 (to the 13th);
  - reasons across the 119: `subscription_canceled` 50, `fraudulent` 26, `product_unacceptable` 16,
    `credit_not_processed` 16, `product_not_received` 6, `general` 4, `debit_not_authorized` 1.

  The November and late-October debits are the likeliest to be open, but that is an inference from timing, not a
  status. To get the number, run `! stripe disputes list --live --limit 100` after `stripe login`, or approve the
  read-only route.

---

## b. One member, one charge: everything held

**The case** (chosen as the newest `subscription_canceled` dispute): user **64658**, membership **41811**,
San Antonio.

| Fact | Value | Where it lives | Clubhouse can read it today? |
|---|---|---|---|
| Joined | 2026-10-10 19:42 Central | `mdapi_subscriptions.activation_date` (mirror of `user_subscriptions.created_at`) | **Yes** |
| First charge | $46.44, 2026-10-10, `subscription_create` | `stripe_member_invoices` | **Yes** |
| Pressed cancel in the app | 2026-10-25 12:10 Central, reason "Moving" | `mdapi_subscriptions.canceled_at`, `cancel_reason` | **Yes** |
| Disputed charge | $71.99, 2026-11-01 01:06 Central, `subscription_cycle` | `stripe_member_invoices` (paid), `fin_txn` (charge row) | **Yes** |
| Dispute | 2026-11-07 18:53 Central, −$71.99, `subscription_canceled` | `fin_txn` (`kind = 'dispute'`) | **Yes** (no status, no due date) |
| Stripe's schedule | told 2026-11-01 01:06 Central (`canceled_at` in Stripe), `cancel_at_period_end: true`, ends 2026-12-01T04:59:59Z = Nov 30 Central | `mdapi_subscription_stripe_end` (0261 + 0272, read 2026-11-13) | **Yes** |
| Bookings in the charged period (November) | **0** | `mdapi_match_players` + `mdapi_matches` | **Yes** |
| Bookings while a member (Oct 11 on) | 2 member spots, both checked in `ON_TIME`, last played 2026-10-11 | same | **Yes** |
| Refunds | none | `fin_txn` (`kind = 'refund'`, this customer) | **Yes** |
| Credits | balance 0 now; no Clubhouse credit write on this player | `mdapi_users.raw.creditAmount`, `change_log` | **Yes**; credit history before Clubhouse: **No** |
| Support chats | none (by player id or phone) | `crm_threads`, `crm_messages` (WhatsApp 705 threads, SMS 73) | **Yes** |
| Terms accepted at signup | **none possible**: joined before the table existed | `membership_terms_acceptances` (backend only) | **No**: no endpoint and no mirror |
| What the cancel sheet showed | **none**: not deployed | `membership_cancel_confirmations` (branch only) | **No** |

**The honest reading of this case.** The player pressed cancel on Oct 25 and was charged on Nov 1 for a month they
played none of, under the old rule (the next paid invoice set the end). The bank's question for
`subscription_canceled` is whether the cancellation policy was disclosed and followed. We hold the cancel timestamp
and the reason. We do not hold proof that a policy was shown at signup or at cancel. This dispute is likely
unwinnable on the evidence we hold.

**Across all 102 disputed charges** (94 memberships, 89 members):
- 87 of the 94 memberships carry a `canceled_at`;
- all 94 were activated before 2026-11-13, so none can have a terms row;
- 19 of the 89 members have a WhatsApp thread with us.

**Where each source lives, and how it is read**

- **`membership_terms_acceptances`.** Backend Postgres, `prisma/schema.prisma:1030-1059`, created by migration
  `20261115000000_add_membership_terms_acceptances`. Written once per signup, before Stripe is asked to charge
  (`subscriptions.service.ts:510-580`).
  - Holds: `accepted_at`, `terms_version`, `charge_text` (the exact charge lines shown), `app_version`,
    `first_charge_cents`, `monthly_charge_cents`, the same two before tax, `tax_rate_percent`,
    `first_full_charge_at`, `ip_address`, `user_agent`.
  - The repository has `create` only (`core/user-subscriptions/membership-terms-acceptances.repository.ts`).
    **No endpoint returns it, and we do not mirror it.**
- **`membership_cancel_confirmations`.** Backend Postgres, **on `feature/cancel-evidence` only**: not on
  `heroku-prod`, `heroku-stage` or `origin`.
  - Holds: `confirmed_at`, `outcome` (`NO_MORE_CHARGES` / `ONE_LAST_CHARGE`), `ends_at`, `last_charge_date`,
    `last_charge_before_tax_cents`, `cancel_reason`, `app_version`, `ip_address`, `user_agent`.
  - Create only. **No endpoint, no mirror.**
- **Bookings and check-ins.** `mdapi_match_players` (`paid_status`, `user_status` ON_TIME / LATE / NO_SHOW,
  `is_absent`, `is_cancelled`, `canceled_at`) with `mdapi_matches` (`start_date` is wall clock, `start_date_utc`
  true UTC). The "check-in" is the attendance status a city manager sets; there is no separate player scan.
- **Cancel and Stripe end.** `mdapi_subscriptions` plus `mdapi_subscription_stripe_end` (nightly, and run by hand
  on 2026-11-13).
- **Refunds.** `fin_txn` (`kind = 'refund'`, joined by `charge_id` or `customer_id`).
- **Credits.** A balance only, `mdapi_users.raw.creditAmount`. Clubhouse credit grants since it gained a credit
  write are in `change_log`. MatchDay keeps no credit history we can read.
- **Support chats.** `crm_threads` / `crm_messages`: WhatsApp and SMS, joined by `player_id` or `phone_number`.
  Message bodies are player PII and must leave only as an export the operator chooses, never be logged.

---

## c. Stripe evidence fields each piece maps to

Field names from stripe v22 `Disputes.d.ts` (`Dispute.Evidence`). Files are uploaded first (`files.create`,
purpose `dispute_evidence`) and then referenced by id.

| What we hold | Stripe evidence field | Notes |
|---|---|---|
| Member name, email | `customer_name`, `customer_email_address` | From the player record |
| Signup IP (terms row) | `customer_purchase_ip` | Only for signups after 2026-11-13 |
| Terms accepted: version, exact charge text, time, app, user agent | `cancellation_policy_disclosure` (text), `customer_signature` (file: a rendered acceptance record), `refund_policy_disclosure` | The core of a `subscription_canceled` defence; absent for every current dispute |
| The membership terms text | `cancellation_policy` (file), `refund_policy` (file) | One PDF per `terms_version` |
| Cancel time, reason, what the sheet showed (cancel confirmation) | `cancellation_rebuttal` (text) | "Cancelled Oct 25; policy: a cancel takes effect at the end of the paid period, and that period was disclosed as …" |
| Stripe's schedule and the final charge | `cancellation_rebuttal`, `service_date` | `service_date` = the period charged |
| Bookings and check-ins in the charged period | `access_activity_log` (text), `service_documentation` (file) | Strong when they played; for 41811 it shows 0 in November, which cuts against us |
| Refunds and credits | `refund_refusal_explanation` (text) | Or the reason no refund was due |
| WhatsApp / SMS threads | `customer_communication` (file) | Exported by a person; never auto-attached |
| Invoice and receipt | `receipt` (file), `product_description` (text) | From Stripe's invoice PDF |
| Prior undisputed charges on the same card, IP or device | `enhanced_evidence.visa_compelling_evidence_3` | Visa only; we hold no device id per charge, so not available as things stand |
| Anything else | `uncategorized_text`, `uncategorized_file` | |

---

## d. What is missing for members who joined on 1.89 or earlier

The backend cutoff is `LAST_APP_WITHOUT_MEMBERSHIP_TERMS = '1.89'` (`subscriptions.service.ts:101`, "1.89 for
now (Ryan, 2026-11-10)"). It must be raised, before release, to the version just before the first app that sends
the acceptance.

| Member | Terms row | What it lacks |
|---|---|---|
| **Joined before the release of 2026-11-13** (every member today, all 94 disputed memberships) | **None** | Everything: no record of what was shown, no IP, no user agent, no acceptance time. Only what MatchDay and Stripe hold: activation, invoices, cancel time. |
| **Joined after the release on app 1.88 or 1.89** | Yes | `charge_text` and `terms_version` are null, so there is no proof of what charge was shown. It does keep the server's own amounts, tax, first full charge date, `app_version` (from the `X-App-Version` header, which 1.88 and newer send), IP and user agent. |
| **Joined after the release on app 1.87 or older** | Yes | As above, and `app_version` is null unless the body carried it (`app_version_source`). |
| **Cancel evidence, any member** | **None until `feature/cancel-evidence` deploys**, and then only for apps that send what the cancel sheet showed (`recordCancelConfirmation` runs only `if (expectedOutcome)`) | For older apps, a cancel leaves only `canceled_at` and `cancel_reason` on `user_subscriptions`. A later resume and cancel overwrites `cancel_reason`. |

For those members the defensible evidence is what MatchDay and Stripe already hold:
- signup and charge dates;
- the cancel timestamp;
- Stripe's schedule;
- attendance in the charged period;
- support threads.

It is enough for "they played in the period they were charged for". It is weak for "they were told the
cancellation rule".

---

## What a Disputes page would need (not built)

1. **A list route.** A read-only server route calling `disputes.list` with the live key, filtered to the open
   statuses, joined to the member through payment intent → `stripe_member_invoices`, sorted by
   `evidence_details.due_by`.
2. **Read access to the backend's evidence.** An admin read endpoint, or a mirror, for
   `membership_terms_acceptances` and `membership_cancel_confirmations`. Today neither is readable from here.
3. **An evidence assembly per dispute** from the sources in §b. Submitting evidence would be a write to Stripe:
   change-logged, one submission only, never retried.
