# Field cover photos — spec (as decided 2026-10-17)

Visual reference: Figma `9TgSk4sYqq4nNoTH73wRRs`, node `19442-44` (Field panel, Match panel, Field Partners
before/after). **Its match-type logic is dropped**; this spec replaces those parts.

## The model

- **Covers are NOT tied to match category or type.** Those drive real app behaviour and stay untouched.
- Each field has a **Default** cover: today's `fields.cover_s3_key`. It is used for every match on Default and for the
  **Field Partners card** (which reads `GET /fields`).
- Each field has **any number of extra covers**, each with a **free-text name** staff choose:
  60 characters at most, unique on the field ignoring case, and never "Default".
- A match uses **Default or one extra cover of its own field**. Resolution: the match's chosen cover, else the field
  Default. Nothing else.

## Field panel — COVER PHOTOS section

- **Default** card: the image, "Used unless a match has its own cover. Also the photo on the Field Partners card.",
  how many upcoming matches are on Default, and **Replace**. There is no remove (the API has no delete for a field's
  cover).
- **Other covers**: one card per extra cover with its **name**, **how many upcoming matches use it**, **Replace**,
  **Rename** and **Remove**, then a dashed **Add cover** tile. (Figma's "Add cover for a match type" becomes "Add cover".)
- **Remove** asks first, with counts read fresh when the confirmation opens: "Remove “Night games”? 4 upcoming
  matches go back to Default. 3 past matches keep it, so its history and old share links look the same."
- Confirming soft-deletes the cover and, in one transaction, puts every match that has **not started** back on
  Default. **Matches that have started keep pointing at the removed cover (Ryan, 2026-10-18).**
- The result line: "LANDED: "Night games" removed (read back from the API). 4 upcoming matches went back to Default; 3
  past matches keep it."
- **Resolver rule**: a removed cover still shows on a match that has started (app payloads, share links, the match
  panel, which says "Removed from the field. This match has been played, so it keeps the photo."), and never on one
  that has not. That second half also covers a past week copied into the future: the copies carry the removed
  cover's id but show the Default.

## Match panel (Gameday Ops) — COVER PHOTO field

- Shows **Default** or the cover's **name**, with a thumbnail.
- **Change ▾** lists Default plus that field's extra covers, then **Save cover**. This is its own commit, outside the
  panel's staged Save.
- **Manage covers on the field ›** opens the Fields page on that field (`/match-ops/fields?field=<id>`).
- **Apply to other upcoming matches**: after a cover lands, it offers the upcoming matches at the same field, weekday
  and start time, all ticked, to apply the same cover in one all-or-nothing call. "Same weekday and start time" is read
  from the wall-clock `startDate`.
- While the panel's **Field** is changed but not saved, Change is greyed: "Save the field change first…". Moving a
  match to another field puts it back on Default.

## Upload

- JPEG, PNG or WebP, up to 10 MB.
- Before saving, it shows **crop previews** for every place the image appears. Each is a centre crop with cover fit,
  using frame sizes read from the app's code:

  | Place | Frame | Source |
  |---|---|---|
  | Match card | ≈ 1.67 : 1 (card width × 0.55 × screen width; assumes 16-pt card margins) | frontend `MatchCard.tsx:66` |
  | Match details header | 4 : 3 | frontend `MatchDetails.tsx:593` |
  | Field Partners card (**Default only**) | ≈ 1.62 : 1 (0.55w × 0.34w) | frontend `FieldsCarousel.tsx:59,81` |
  | Share preview | 1200 × 630 | go-playmatchday `app/match/[id]/opengraph-image.tsx:16,126` |

- **"Keep text in the center" guide**: a dashed box over the image marking the part every shape keeps. Anything
  outside it is cut off in at least one place.

## Who

- Reads need **Match Ops**.
- Writes need **EDIT MATCHES** (`can_edit_matches`), the same grant that edits a match today. Greyed buttons are a
  courtesy only; the route and the write client both refuse.
- City-confined accounts are refused, because covers apply to a whole field.
- On the backend the endpoints are **ADMIN-only**, with the Match Manager staff identity rules: the Clubhouse service
  account must send `X-Acting-Staff-Email`, which is the signed-in person's email from the server session.

## App and go.playmatchday.com

No code changes. Both already read `match.field.cover`, which now carries the match's resolved cover.
`match.coverUrl` carries the same value. `GET /fields` and `GET /fields/:id` keep returning the Default.
