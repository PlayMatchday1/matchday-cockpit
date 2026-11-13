# Retool MEMBERSHIPS page — inventory (2026-11-13)

**Source.** `docs/retool/membership-app.json`, the whole MatchdayDashboardProd app, exported 2026-11-13
(moved from `~/Downloads/MatchdayDashboardProd (2).json`; `(1)` was byte-identical). The file is Transit-encoded
Retool app state; every query and widget below was read from it, not from Retool's UI.

**Backend.** Every "what it does" was read in the NestJS source at **`8965437`**. That is `heroku-prod/master`
(the ref on the production Heroku remote), equal to `origin/master` on 2026-11-13. Paths are relative to
`~/Code/backend/apps/api/`. Nothing was called against the production API for this inventory.

**Database.** Two read-only counts were taken from our mirror `mdapi_subscriptions` (synced 2026-11-13 10:40 UTC).

**Not done.**
- No write was made anywhere.
- Retool was opened only as a file.
- Stripe's dashboard (which webhook events are subscribed) was not checked; where that matters it is marked UNKNOWN.
- Line numbers in the 2026-09-30 facts section came from an older checkout and differ from the ones here.

There is one page. The sidebar item is **MEMBERSHIPS** (view key `Memberships`, container `container21`);
its title reads **MEMBERS**. Nothing else in the app is a members page.

---

## 0. Things to know before reading the rest

1. **Edit Member and Delete Member act on the SELECTED row, and a row is selected by default.** The members
   table has `defaultSelectedRow: "first"`. Click Delete Member without clicking a row first and it ends the
   membership of whoever is first on the page. The confirm modal says only "Unsubscribe this user?" and shows
   no name.
2. **`ADDED_FROM_ADMIN` ("Add Member") is not a comp.** It is a held-price invitation. The player gets no
   member pricing until they check out in the app. That checkout charges $1 now and the held price from the
   next month. See §5.
3. **Retool's members list DOES include `ADDED_FROM_ADMIN`.** It comes from `GET /admin/subscriptions?status=ACTIVE`,
   whose SQL admits both statuses. Our sync stores what that call returns, and the mirror holds **0** such rows.
   So production most likely holds none right now. See §4.
4. **Email Members goes to every city.** It sends to every `status=ACTIVE` row, including the 102 players who
   have already cancelled. The city picker on the page does not apply to it.
5. **The members list endpoint builds its SQL by pasting `email` and `cityIdentifier` straight into a raw query.**
   Any admin or city-manager token reaches it. That is a backend defect for whoever owns the backend, noted in the
   facts doc; nothing Clubhouse sends is affected.

---

## 1. Every query the page uses

All REST queries send `Authorization: Bearer {{ localStorage.values.accessToken }}` to `globalVar.serverApiUrl`
= `https://playmatchday.herokuapp.com`. Note: there is **no `/api/v1` prefix** on these. The Comment save is the
one exception.

### Reads

| Query | Call | Inputs | Triggered by |
|---|---|---|---|
| `getAllSubscribers` | `GET /admin/subscriptions?page&limit&email&status=ACTIVE&sortColumn&sortDirection&cityIdentifier` | members table page/size/sort, `searchByEmailField`, city select | Sidebar click; city change; search change (0.5 s debounce); table sort/page; after Delete Member, after Save Comment |
| `getAllCanceledSubscribers` | `GET /admin/subscriptions?status=CANCELED&…` (same params) | previous-members table, `searchByEmailPreviosMembers`, city | Runs on model update (any input change); city change; table sort/page; after Delete Member |
| `getSubscriptionByCityId` | `GET /admin/subscriptions/cities/{cityAbbr}` | city select | Model update; city change; after Change Master Price |
| `getStrikePriceByCityId` | `GET /strikes/cities/{cityAbbr}` (player route, no `/admin`) | city select | Model update; after Change Strike Price |
| `getUserByIdFromMembership` | `GET /admin/players/{userId}` | `subscribersTable.selectedRow.userId` | Row click on the members table; after Remove/Add Strike |
| `getUsersForMembership` | `GET /admin/players?email&id&limit&page&sortColumn&sortDirection` | Add-member picker search boxes, its table | Add Member modal opens; search change (email) / submit (id); table page/sort |
| `getForDownloadMembers` | **Direct SQL on the production Postgres** (resource `17d8a898…`): every `user_subscriptions` row joined to users/cities/time zones, `ORDER BY us.id DESC` | none | Runs on model update, so it loads on page open |
| `downloadMemberships` | JavaScript: turns `getForDownloadMembers.data` into `members.csv` | none | Members table "Download All" button |
| `downloadUserData` | JavaScript over `getUsersFromDB` (direct SQL) → `users.csv` | none | Add-member picker "Download all" |
| `getCities` | `GET` cities (shared) | none | Sidebar click; fills the city select |
| `getNewSubscriptionName` | Function: today's date `M/D/YYYY` | none | Read by `changeMasterPrice` |

### Writes

| Query | Call and body | Triggered by | Confirm step |
|---|---|---|---|
| `changeMasterPrice` | `POST /admin/subscriptions` `{ name: "<M/D/YYYY> <dollars>$", price: dollars×100, cityAbbr }` | "Change" in the Change Master Price modal | **None** |
| `changeStrikePrice` | `POST /admin/strikes/cities/{cityAbbr}` `{ price: dollars×100 }` | "Change" in the Change Strike Price modal | **None** |
| `updateSubscriptionPriceForMember` | `PATCH /admin/subscriptions/{membershipId}` `{ price: dollars×100 }` | "Change" in the Edit Member modal | **None** |
| `unsibscribeMember` | `POST /admin/subscriptions/{membershipId}/unsubscribe` `{ reason: "Removed by Retool" }` | "Yes" in the Delete Member modal | **Yes/No modal** ("Unsubscribe this user?") |
| `subscribeUser` | `POST /admin/subscriptions/users/{userId}` (no body) | "Add User" in the Add Member modal | **None** |
| `subscribeUserAsFreeMember` | `POST /admin/subscriptions/users/{userId}/free` (no body) | "Add User as Free Member" | **None** |
| `sendEmailForSubscribers` | `POST /admin/subscriptions/email` `{ text: <rich-text HTML> }` | "Send email" in the Email Members modal | **None** |
| `updateUserSubscriptionComment` | `PUT /api/v1/admin/user-subscriptions/{membershipId}` `{ comment }` (raw JSON) | "Save Comment" in the member detail modal | **None** |
| `removeStrike` | `DELETE /admin/strikes/strike-logs/{strikeLog.id}` body `{ userId, matchId }` (the backend ignores the body) | "Remove N" button cell in the member's match table | **None** |
| `setStrike` | `POST /admin/strikes` `{ userId }` | "Add Strike" button, **hidden** (`hidden: true`) | n/a |

`removeStrike` is also wired to a header "Remove Strike" button that is hidden. The live way in is the button
column, enabled only when that match's strike log has points > 0 and an unexpired parent strike.

### Writes on OTHER pages that touch membership, strikes or subscriptions

- **None write `user_subscriptions` or `strikes`.**
- `makeAbsentPlayerFromMatch` (Matches page) calls `PATCH /admin/matches/{matchId}/user-matches/{id}/absent`.
  **There is no such route in the production backend.** No controller matches "absent"; the admin match routes
  are listed in `src/core/matches/controllers/admin-matches.controller.ts:119-474`. So this query 404s.
  "Absent" (which feeds Absent owed) is set only by the attendance flow, `updateUserMatchStatus`
  (`src/core/user-matches/user-matches.service.ts:302-307`): `isAbsent = (status === NO_SHOW)`.
  Strikes come from the same flow (`matches.service.ts:1886-1901`, members only).
- `suspendUser` / `expellUser` / `unExpellUser` (Users page) are **bans**, `POST|DELETE /admin/players/{id}/ban`.
  This is a separate mechanism from strikes (facts doc, "Bans are a SEPARATE mechanism from strikes").
- `deleteUserById` (Users page) calls `DELETE /player/profile/{id}`, which runs `softDeleteUser`
  (`users.service.ts:562-580`). **It does not touch the membership or the Stripe subscription.** A deleted
  account keeps being billed until someone ends it.
- `refundAndCancelPlayerMatch`, `removePlayerFromMatch` and `deletePlayerFromMatchById` (Matches page) were read
  (`matches.service.ts:1929-2000`). They create and reset no strikes and touch no subscription.

---

## 2. Every screen element

### Header row (city picker and actions)

- **Cities** select (`filterUserSubscriptionCity`).
  - Options come from `getCities`; the value is the city **abbr**; fuzzy search.
  - **It defaults to the first city in the list.**
  - Changing it re-runs both tables and the Member Price.
- **"Member Price $X"**: the city plan price, `getSubscriptionByCityId.price / 100`.
- **Change Master Price** button opens a modal.
  - One input, "Enter the new price": dollars, min 0, **blank by default**.
  - One "Change" button: fires immediately; the modal closes on success.
- **"Strike Price $X"**: `getStrikePriceByCityId.amount / 100`.
- **Change Strike Price** button opens a modal.
  - The input is **prefilled** with the current price.
  - One "Change" button, no confirm.
- **Search by Email or Phone** (`searchByEmailField`): filters the members table server-side.
- **Email Members**: a modal with the heading "Send email for all active users", a rich-text editor, and "Send
  email". The button sends, then closes the modal.
- **Edit Member**: a modal, "Set new price for a member".
  - One dollar input, blank by default.
  - One "Change" button. On success the members table refreshes. Acts on the selected row.
- **Delete Member**: a modal, "Unsubscribe this user?", with **Yes** / **No**.
  - Yes runs the unsubscribe, closes the modal, and refreshes both tables. Acts on the selected row.
- **Add Member**: a 740 px modal (detailed below).

### Members table (`subscribersTable`, data `getAllSubscribers.data.data`)

- Server-side paging and sorting; default sort `membershipId`; row checkboxes.
- Retool's filter button, refresh button, download button (current page), and **Download All** (§1).
- **Default selected row: first.**

Visible columns, in order:

| Header | Field | What it is (backend `src/core/subscriptions/subscriptions.repository.ts`) |
|---|---|---|
| MEMEBER ID | `cityIdentifierAndMemberId` | `city_identifier ‖ user_sub_id`, e.g. `ATX597` (:71) |
| MEMBER EMAIL | `memberEmail` | `users.email` |
| PHONE NUMBER | `phoneNumber` | `users.phone_number` |
| STATUS | `status` | raw `user_subscriptions.status`: `ACTIVE` or `ADDED_FROM_ADMIN` here |
| FIRST NAME / LAST NAME | | `users` |
| COMMENT | `comment` | `user_subscriptions.comment` (§3) |
| ACTIVATION DATE | `activationDate` | `us.created_at`: **the row's creation**, not the first payment (:77) |
| MEMBERSHIP LENGHT | `membershipLength` | **the number column after Activation date**: whole days elapsed since `us.created_at`, `extract(day from NOW() - created_at)` (:79). It counts from row creation for every status and keeps growing after a cancel. |
| CANCELED MEMBERSHIP DATE | `canceledAt` | `us.canceled_at`: the moment cancel was pressed (§6) |
| ABSENT OWED | `absentOwed` | displayed as `$` + value (§5) |
| PRICE | `price` | `(us.amount / 100)::INTEGER`: **whole dollars, truncated** (:80) |
| STRIKE POINT | `strikePoints` | the sum of `penalty_point` over the **current** (unexpired) strike's logs (:82, join :96) |
| SUSPENDED TO | `suspendedTo` | `strikes.suspended_to` of the current strike (:83) |

Hidden: `userId`, `cancelReason`, `membershipId`.

**Row click** runs `getUserByIdFromMembership` and opens the member detail modal.

### Member detail modal (`showUserFromMembership`)

**"Member Strike Details"**

- Member Name; MEMBER ID (from `userSubscriptions[0]`); MEMBER EMAIL; PHONE NUMBER.
- **Comment** input, prefilled from `getUserByIdFromMembership.userSubscriptions[0].comment`, with a **Save
  Comment** button.
- SUSPENDED (✅ if `strike.isSuspended`); Active Strikes; Suspension Started; Suspension Ended (`suspendedTo`);
  Date of First Active Strike (`strike.createdAt`); Date Strike Reset (`strike.expiredAt`).
- Add Strike / Remove Strike header buttons: **both hidden**.

**"MATCHES DETAILS"** table (`getUserByIdFromMembership.matches`)

- Columns: ID (match id), MATCH NAME, PRICE $ (`amount/100`, summed in the footer), reserved flag,
  CANCELLED BY USER, REFUNDED, TEAM, START DATE, END DATE, MATCH TYPE, GOALS SCORED.
- Then ✅ columns for Cancel w/in 6 hours, On Time, Late, Absent (from `userStatus`), `canceledAt`,
  `cancelledBefore24Hours`, and **Remove Strike** (a button labelled "Remove N", or the text "Expired N").
- Defect: **GOALS SCORED reads `getUserById.data.goals`**, a query belonging to the Users page, not this
  modal's `getUserByIdFromMembership`. It shows another player's goals, or nothing.

### Add Member modal (`addUserSubscriptionModal`)

- Opening it loads `getUsersForMembership`.
- Search By Email (on change) and Search By Id (on enter).
- Player table, `usersMembershipTable`:
  - Columns: ID, EMAIL, FIRST NAME, LAST NAME, REGISTRATION DATE, SOCCER LEVEL, PHONE NUMBER, CITY MANAGER.
  - **Default selected row: none.**
  - "Download all" button → `users.csv`.
- **Add User** runs `subscribeUser` and **Add User as Free Member** runs `subscribeUserAsFreeMember`. Each then
  closes the modal and refreshes the members table. **No confirm.**
- **The city for either add is the player's preferable city, not the city picker on the page.**
- A hidden nested user modal (`showUser3`) exists and is unreachable.

### Previous Members table (`previousSubscribersTable`, data `getAllCanceledSubscribers.data.data`)

- It has its own Search by Email or Phone, and is filtered by the same city picker.
- The status filter is `status IN (CANCELED, PAST_DUE)` (`subscriptions.repository.ts:61`), so **past-due
  members are listed as "previous"**.
- Visible columns: MEMBER ID, MEMBER EMAIL, PHONE NUMBER, STATUS, FIRST/LAST NAME, ACTIVATION DATE,
  CANCELED MEMBERSHIP DATE, ABSENT OWED, PRICE, STRIKE POINTS, SUSPENDED TO, CANCEL REASON.
- `membershipLength` is hidden here.
- **No actions**: no row click and no buttons beyond Retool's own.

---

## 3. Feature by feature: does the Clubhouse have it?

| Retool feature | Clubhouse | Where |
|---|---|---|
| Per-member list of active members, per city, with search | **Partly.** There is no list. Members by City is per-city counts and billing from the mirror; Player Lookup is one player at a time. | `src/components/MembersByCityView.tsx`, `src/lib/membersByCity.ts`, `src/components/PlayerLookup.tsx` |
| Previous-members list | **Partly**, per player only (membership history). | `src/app/api/lookup/[env]/membership-history/route.ts` |
| Member Price display (city plan) | **Partly.** A max-active-price snapshot, not the plan row. | `src/app/api/sync/membership-prices/route.ts` |
| Change Master Price | **No** | none |
| Strike Price display / Change Strike Price | **No** | `src/lib/appActivity.ts:73` only labels the app's GET |
| Email Members | **No** | none |
| Edit Member (price) | **Yes**, with our own guards: integer cents, ≥ 0, not a closed row, not a no-op | `src/app/api/matchday/[env]/memberships/[subscriptionId]/price/route.ts`, `src/lib/membershipAdminModel.ts:61-70`, button `PlayerLookup.tsx:1139` |
| Delete Member (end) | **Yes**, with a required reason (Retool sends "Removed by Retool") | `src/app/api/matchday/[env]/memberships/[subscriptionId]/end/route.ts`, `PlayerLookup.tsx:1140` |
| Add Member (`ADDED_FROM_ADMIN`) | **Built, switched off** (`COMP_ADD_ENABLED = false`; the route answers 409). Its stated reason is half wrong; see below. | `src/lib/membershipAdminModel.ts:168-172`, `src/app/api/matchday/[env]/memberships/add/route.ts` |
| Add User as Free Member ($0) | **Yes** | same add route, `PlayerLookup.tsx:1141` |
| Comment (view / save) | **No.** The mirror does not carry it; Player Lookup does not show it. | none |
| Member detail: strike block | **Yes** | `PlayerLookup.tsx` strike panel (types `:127-128`) |
| Remove Strike | **Yes**, with a reason, into `change_log` | `src/app/api/matchday/[env]/strikes/[strikeLogId]/route.ts` |
| Add Strike (7-day suspension) | **No.** Hidden in Retool too. | none |
| Member's match history | **Yes** | `PlayerLookup.tsx:893` `MatchHistoryPanel` |
| Absent owed | **No** | none |
| Strike points / suspended-to as list columns | **No** list; per player in Lookup | `src/lib/playerProfile.ts` |
| Membership length | **Not shown** (the mirror stores it) | none |
| Download all members CSV | **Partly.** Members by City exports its per-city table. | `MembersByCityView.tsx` |

**The comp switch's reason is half wrong.** `COMP_DISABLED_REASON` says MatchDay "returns it from no endpoint".
The list endpoint does return `ADDED_FROM_ADMIN` rows (`subscriptions.repository.ts:56-58`, count `:17-20`). Only
the player detail hides them (`src/core/users/users.repository.ts:478-487` keeps `ACTIVE` with an unexpired period
only). A comp could therefore be shown and ended via the list's `membershipId`. Whether it should be re-enabled
depends on §5: it is an invitation, not a free membership.

---

## 4. Every place Retool reads membership data, and whether `ADDED_FROM_ADMIN` is in it

| Read | Includes `ADDED_FROM_ADMIN`? | Evidence |
|---|---|---|
| Members table `GET /admin/subscriptions?status=ACTIVE` | **Yes** | `subscriptions.repository.ts:56-58` (`us.status IN ('ACTIVE','ADDED_FROM_ADMIN')`); total count `:17-20` |
| Previous Members `status=CANCELED` | No (CANCELED + PAST_DUE) | `:61` |
| Member detail `GET /admin/players/{id}` → `userSubscriptions` | **No.** Only `ACTIVE` with `currentPeriodEnd ≥ now`. | `users.repository.ts:478-487` |
| Download All, direct SQL `getForDownloadMembers` | **Yes.** Every row of every status, all cities, deleted rows too. | the query text in the export |
| User Analysis page SQL (`is_member`) | **No.** It counts `status IN ('CANCELED','ACTIVE')` with a period covering the match; $0 members count. | `getUserForAnalysis` / `getTotalCountForUserForAnalysis` in the export |
| Email Members recipients | **No.** `status = ACTIVE`, `deletedAt = null`. | `subscriptions.service.ts:524-541` |

**So Retool gets them from the members list endpoint and from its direct database export.** Our mirror is filled
from that same list endpoint, and the sync stores every row the ACTIVE call returns without filtering on status
(`src/lib/mdapiSubscriptionsSync.ts:270-305`). The mirror at 2026-11-13 10:40 UTC holds ACTIVE 356,
**ADDED_FROM_ADMIN 0**, CANCELED 2,669, PAST_DUE 1 (the ACTIVE count is the positive control for the same query).
So production most likely holds no `ADDED_FROM_ADMIN` rows right now. A row like that also stops being one when
the player checks out (§5), which would explain why they don't accumulate. Not verified against a live list call.

---

## 5. Exactly what each action does

### Change Master Price

`POST /admin/subscriptions` → `createOrUpdateSubscription` (`subscriptions.service.ts:64-104`).

1. Looks up the city by abbr. If its plan already has this exact price, it returns without doing anything (:72-74).
2. **Stripe:** creates a new Product named `"<M/D/YYYY> <dollars>$"` (:76) and a new **monthly recurring Price**
   on it (:79-83).
3. Writes the city's `subscriptions` row: `price`, `stripeProductId`, `stripePriceId` (:85-90). If the city has no
   plan, it creates one (:92-102).

**New signups only.** No existing member's Stripe subscription is touched, and nothing iterates over members.
- A new in-app signup reads the plan's `stripePriceId` at checkout (:228, :262).
- **An `ADDED_FROM_ADMIN` row added before the change keeps its stored `stripePriceId`** (:369), so it checks out
  at the old price.

Validation: `price` cents, `@IsNumber() @Min(50)`. Retool sends dollars × 100 with no rounding: $19.99 sends
`1998.9999999999998`. That passes `@IsNumber`, and Stripe takes only integer `unit_amount` (Stripe API; not
probed here). It would fail after the Product was created. Guarded by `CityManagerOrAdminAuthGuard`, so a city
manager can do this.

### Change Strike Price

`POST /admin/strikes/cities/{cityAbbr}` → `setStrikePriceByCityAbbr` (`src/core/strikes/strike.service.ts:84-88`)
→ an upsert of `strike_prices.amount` for the city (`strike.repository.ts:102-115`).

- **No Stripe object is created.** The price is read when a suspended player pays to lift the suspension.
  At that moment `createPayment` builds a Stripe invoice for the current amount (`strike.service.ts:107-145`).
- **The body is not validated.** The controller declares it as an inline type, `@Body() dto: { price: number }`
  (`admin-strike.controller.ts:35-38`). With no DTO class, the global `ValidationPipe` has nothing to check, so a
  negative, fractional or string price reaches Prisma.
- Guard: `CityManagerOrAdminAuthGuard` (:12).

### Delete Member

`POST /admin/subscriptions/{id}/unsubscribe` `{ reason: "Removed by Retool" }` → `unsubscribeForAdmin` (:468-482).

- Only rows that are not CANCELED and not soft-deleted match. When nothing matches it returns `false` on a 2xx.
- For each match (`cancelSubscriptionsForAdmin`, :561-578):
  1. If the row has a `stripeSubscriptionId`, **Stripe `subscriptions.cancel(id)`**
     (`src/core/stripe/stripe.service.ts:340-346`). This cancels **immediately**, with no proration and no refund.
     A Stripe error is caught and ignored (:567-569).
  2. Writes `canceledAt = now`, `cancelReason`, `status = CANCELED`.
- An `ADDED_FROM_ADMIN` row has no Stripe subscription, so only the row changes.
- **Retool sends a canned reason**, which is why "Removed by Retool" is the most common cancel reason in the mirror.

### Add Member ("Add User")

`POST /admin/subscriptions/users/{userId}` → `subscribeSpecificUser` (:341-375).

- Refuses if the player already has an `ACTIVE` or `ADDED_FROM_ADMIN` row. A CANCELED row does not block it.
- Writes a row: `status ADDED_FROM_ADMIN`, `amount` = the city plan price, `stripePriceId` = the city plan's
  Stripe price, the next `user_sub_id` for the city. The city is the **player's preferable city**.
- **Nothing in Stripe at add time.**

**What it means for the player:**
- **They are not a member yet.** `isMember` requires `status = ACTIVE` and `currentPeriodEnd ≥ now`
  (`src/core/user-subscriptions/user-subscriptions.repository.ts:76-88`), so they get no free matches.
- **The app shows them a $1 join price.** `getSubscription` returns `price` = the held amount and
  `membershipPrice` = 100 cents (:119-134).
- **When they press subscribe**, `subscribe` routes them to `subscribeFromAdmin` (:195-201, :283-331). That:
  - creates a real Stripe subscription at the held `stripePriceId`;
  - adds a **one-time $1.00 invoice item** (`minOneTimeSubscriptionPrice = 100`, :47);
  - starts a trial to the end of the month (`stripe.service.ts:228-232`).

  The invoice webhook then sets the row's status from Stripe, and `trialing` reads as `ACTIVE`
  (`stripe.service.ts:837-842`).

**So "Add Member" is "lock this player's price and let them join for $1 this month".** It is not a free
membership. The facts doc's 2026-09-30 entry calls it "the COMP … Nothing is ever charged", which is true only
until the player checks out.

### Add User as Free Member

`POST /admin/subscriptions/users/{userId}/free` → `subscribeSpecificUserFree` (:377-436).

1. **Stripe:** creates the Customer if missing.
2. Creates a new Product and a **$0 monthly recurring Price** (`createRecurringProductAndPrice(0, abbr)`,
   `stripe.service.ts:366-377`).
3. Creates a **real subscription** with no invoice items.
4. Writes the row `status ACTIVE`, `amount 0`, with the Stripe id and period.

This one is a real member at once and reaches our mirror; our paid-member rules exclude it by price.

### Edit Member

`PATCH /admin/subscriptions/{id}` `{ price: dollars×100 }` → `updateSubscriptionPrice` (:484-505).

- No status or soft-delete filter.
- **An `ADDED_FROM_ADMIN` row:** a new Stripe Product and recurring Price are created; the row's `amount` and
  `stripePriceId` change. That is the price they will check out at.
- **Every other row** goes through `updateUserSubscriptionPrice` (:580-597):
  1. Creates a new Stripe Product and recurring Price.
  2. `updatePriceForSubscription` (`stripe.service.ts:256-267`) retrieves the subscription and **swaps item 0 to
     the new price with `proration_behavior: 'none'`**. The current month is neither re-charged nor refunded; the
     **next renewal** charges the new price.
  3. Writes the row's `amount` and `stripePriceId`.
- **Correction to the facts doc:** a Stripe failure here is **NOT swallowed.** `updatePriceForSubscription` has no
  try/catch, so the error propagates as a 500 **before** the row update. The `res instanceof Error` check at
  :589 can never fire.
- **What a failure leaves behind.** The Product and Price from step 1 already exist in Stripe as orphans.
  - A $0 member hits this: the row has a Stripe subscription, but whether Stripe accepts the swap is untested.
  - A row with no `stripeSubscriptionId` hits it for certain: `retrieve('')` throws.
  - Fractional cents from Retool's `×100` hit it too.

### Email Members

`POST /admin/subscriptions/email` `{ text }` → `emailActiveSubscribers` (:524-541).

- **Recipients:** every `user_subscriptions` row with `status = ACTIVE` and `deletedAt = null`, **in every city**,
  de-duplicated by email.
  - That includes players who have already cancelled but whose row is still ACTIVE: **102 in the mirror today**.
  - It excludes `ADDED_FROM_ADMIN` and `PAST_DUE`.
- **Sender:** the backend calls **SendGrid** v3 `mail/send` once, with one personalization per address
  (`src/core/email/email.service.ts:52-59`).
  - From `sendgridConfig.emailFrom` / `nameFrom`.
  - Subject **"MatchDay SC Member Notice"**.
  - Body: the editor's HTML **verbatim** (`email-template-factory.ts:274-279`).
- **Failure is invisible to the caller.** A SendGrid error is caught and the endpoint still returns `true`.
  - The catch **logs every recipient address and the full body** to the Heroku log (`email.service.ts:98-112`).
  - SendGrid caps one request at 1,000 personalizations (SendGrid docs; not probed). That is not near 356, but the
    whole send would fail silently past it.
- Not Klaviyo; not SMS.

### Comment field

- **Where it is stored:** `user_subscriptions.comment`, a nullable `TEXT` (`prisma/schema.prisma`,
  model `UserSubscription`, line 930+).
- **The save:** `PUT /api/v1/admin/user-subscriptions/{id}` `{ comment }`
  (`src/core/subscriptions/api/v1/api-v1-admin-subscriptions.controller.ts:33-39`) → `updateUserSubscriptionComment`
  (`subscriptions.service.ts:518-522`). It is a 404 if the row is missing.
- **A 2xx is not proof.** The repository's `updateById` catches any error and returns `null`
  (`user-subscriptions.repository.ts:123-131`), so a failed write answers 2xx with an empty body.
- **Retool trap: the box can wipe a comment.**
  1. The box is prefilled from `/admin/players/{id}` → `userSubscriptions[0].comment`.
  2. That include drops `ADDED_FROM_ADMIN` rows and any ACTIVE row whose period has lapsed.
  3. For those members the box opens **empty**, and Save writes `""` over the stored comment.
- The members table's COMMENT column (from the list endpoint) shows the real value.

### Absent owed (both tables)

`subscriptions.repository.ts:84-93`. For each membership row it sums **`matches.registration_price / 100`** over
that player's `user_matches` where all of these hold:

- `is_absent` is true, which is set only when the attendance status is `NO_SHOW`;
- `paid_status = 'FREE'`, i.e. a member spot;
- the booking was not cancelled (`canceled_at IS NULL`);
- it was booked **after** the membership row was created and **before** `current_period_end`.

What that means:
- `current_period_end` rolls forward on every renewal, so the window is the **whole life of the membership**, not
  this month.
- `registration_price` is integer cents, so `/ 100` is **integer division**: $7.50 counts as $7.
- A row with no period end (`ADDED_FROM_ADMIN`, incomplete) shows **0**.
- **It is display-only.** Nothing in the backend charges, invoices or reads it; it appears only in this query.

### Why a member shows ACTIVE with a cancel date in the past

`canceledAt` is when the player pressed cancel, and the in-app cancel does not change the status. The sequence:

1. **The player cancels in the app.** `cancelSubscriptions` (`subscriptions.service.ts:543-559`) writes
   `canceledAt = now` and `cancelReason` **only**. The status stays ACTIVE and **Stripe is not called**.
2. **The next invoice is paid.** The `invoice.paid` webhook sees `canceledAt` and only then sets Stripe
   `cancel_at_period_end: true` (`stripe.service.ts:854-858`). So the player is billed once more (facts doc,
   2026-10-31: "every in-app cancel is charged once more on the next 1st").
3. **Stripe ends the subscription.** Stripe sends `customer.subscription.*` to `POST /stripe/webhook/subscription/update`.
   `webhookSubscriptionUpdate` (`stripe.service.ts:911-967`) copies Stripe's status onto the row, and only now does
   it read **CANCELED**. Which events the Stripe dashboard sends to that route: UNKNOWN (not checked).

**Measured on the mirror today: 102 ACTIVE rows carry a `canceled_at`.**
- **All 102 were pressed on or after 2026-10-01** (60 in October, 42 in November), and none earlier.
- That fits the sequence. Cancelled in October → charged November 1 → ends at the end of November. Cancelled in
  November → charged December 1 → ends at the end of December.
- Older cancellations have all flipped to CANCELED, so step 3 is happening.

**A cancel date in the near future is not something the backend writes.** `canceledAt` is always `new Date()` at
the press (:548, :572), and the mirror holds **0** ACTIVE rows with a future `canceled_at`. If Retool showed one,
the likeliest candidate is the neighbouring **SUSPENDED TO** column, which is a near-future date for suspended
players. Not verified on screen: UNKNOWN.

---

## 6. Added to `docs/matchday-api-facts.md`

New section "Retool MEMBERSHIPS page, read against backend 8965437 (2026-11-13)". It covers:

- `ADDED_FROM_ADMIN` is a held-price invitation (it corrects the 2026-09-30 "comp" wording).
- The mirror evidence resolving the 2026-11-07 CONTESTED note.
- The master price touches new signups only.
- The Edit Member Stripe error is not swallowed (it corrects 2026-09-30).
- The strike price lives only in our database, with an unvalidated body.
- `POST /admin/strikes` is a 7-day suspension; the remove-strike body is ignored, and removing can restart the week.
- Email Members' recipients, sender, and silent failure.
- Comment storage, the null-on-error repository, and the Retool wipe trap.
- How Absent owed and Membership length are computed.
- The Retool "absent" query has no route.
- Deleting a player leaves the membership billing.
- The list endpoint's raw SQL interpolation.
