// Centralized fake-player detection for any code touching
// mdapi_match_players rows.
//
// Two signals combined for defense-in-depth:
//
//   1. user_is_fake_player boolean — set by the MatchDay API per
//      registration row when the slot was filled by a synthetic
//      placeholder (the "Set Or Reset as Fake Player" action).
//      Primary signal, but reportedly set sparsely in practice —
//      don't rely on it alone.
//
//   2. user_email pattern @matchday.com — synthetic fills carry
//      emails like 59@matchday.com, 114@matchday.com. Catches the
//      long tail of fakes whose boolean flag wasn't set upstream.
//
// CRITICAL: the company's real staff use @playmatchday.com — one
// word longer than the fake domain. The email regex is anchored
// with `@…$` so @playmatchday.com does NOT match @matchday.com.
// Past code used `email.toLowerCase().includes("matchday.com")`
// which over-matched and treated staff as fakes / staff exclusion;
// using this helper everywhere prevents that bug class from
// recurring.

const FAKE_PLAYER_EMAIL_RX = /@matchday\.com$/i;

// True iff the email string is a synthetic @matchday.com fake.
// Safe against @playmatchday.com staff emails (returns false).
export function isFakePlayerEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  return FAKE_PLAYER_EMAIL_RX.test(email);
}

// True iff a player-registration row represents a synthetic fake
// fill. Checks both the platform boolean AND the email pattern,
// so a fake whose boolean flag wasn't set still gets caught via
// the email tail.
export function isFakePlayerRow(row: {
  user_is_fake_player?: boolean | null;
  user_email?: string | null;
}): boolean {
  if (row.user_is_fake_player === true) return true;
  return isFakePlayerEmail(row.user_email);
}
