// THE POPUP HEADLINE'S AUTO-FIT, the app's own rule, ported line for line from frontend feature/announcement-popups
// src/utils/headlineFit.ts (frontend-ota, read 2026-11-09 while still uncommitted there). Client-safe. Keep the two in
// step: the preview is only right while this is the same arithmetic the phone does.
//
// The app's comment, kept:

import { withPreviewName } from "./offersModel";

// Fits the popups' two-part headline ("NOW *OPEN*") to the card: the
// design's size when it fits on one line, a smaller one down to 28pt, and
// two lines at 28pt for the longest. Each part can be 64 characters
// (backend docs/offers/announcements.md), so a headline can be far wider
// than the card.
//
// Widths come from Titillium Web's own advance widths (per 1000 units of
// size, read from src/assets/fonts with fontTools), not from measuring on
// screen: the popup opens at its final size, with no second layout pass.
// The font only ever kerns capitals closer together, so the sum is never
// narrower than what the phone draws.

const BOLD: Record<string, number> = {
  ' ': 220, '!': 280, '"': 411, '#': 560, $: 560, '%': 560, '&': 701,
  "'": 239, '(': 308, ')': 308, '*': 425, '+': 560, ',': 263, '-': 408,
  '.': 256, '/': 466, ':': 256, ';': 279, '<': 560, '=': 560, '>': 560,
  '?': 437, '@': 973, '[': 355, '\\': 498, ']': 355, '^': 560, _: 620,
  '`': 268, '{': 361, '|': 268, '}': 361, '~': 560, '’': 254, '·': 256,
  A: 602, B: 609, C: 543, D: 638, E: 554, F: 531, G: 611, H: 677, I: 286,
  J: 302, K: 593, L: 472, M: 858, N: 693, O: 652, P: 589, Q: 652, R: 620,
  S: 544, T: 526, U: 654, V: 603, W: 930, X: 569, Y: 557, Z: 532,
};

const BOLD_ITALIC: Record<string, number> = {
  ' ': 220, '!': 163, '"': 306, '#': 560, $: 560, '%': 560, '&': 641,
  "'": 138, '(': 234, ')': 235, '*': 423, '+': 560, ',': 175, '-': 267,
  '.': 152, '/': 468, ':': 158, ';': 175, '<': 560, '=': 560, '>': 560,
  '?': 431, '@': 959, '[': 246, '\\': 484, ']': 245, '^': 560, _: 478,
  '`': 518, '{': 288, '|': 335, '}': 287, '~': 560, '’': 174, '·': 151,
  A: 551, B: 573, C: 494, D: 605, E: 497, F: 477, G: 568, H: 620, I: 268,
  J: 283, K: 540, L: 422, M: 789, N: 651, O: 615, P: 547, Q: 615, R: 559,
  S: 495, T: 456, U: 595, V: 555, W: 865, X: 520, Y: 504, Z: 490,
};

// Digits are all 560 in both
const DIGIT = 560;
// A character the font lacks is drawn from the system font: counted wide,
// an emoji wider, so the guess errs towards a smaller size
const OTHER = 700;
const EMOJI = 1300;
// The hair space after the italic part (PromoPopup's ITALIC_TAIL) is not in
// Titillium either; the system fonts' is under 0.1 em
const TAIL = 100;

// The headline's padding, in points, whatever the size: pl-2 on the plain
// part when there is an accent, ml-2 (or pl-2 alone) and pr-2 on the accent
const PAD = 8;

/** The card's width for the headline: 312pt at most, inside px-8 of
 * screen and px-5 of card (PromoPopup). */
export const headlineMaxWidth = (windowWidth: number) =>
  Math.min(312, windowWidth - 64) - 40;

export const HEADLINE_MIN_SIZE = 28;

const advance = (text: string, italic: boolean) => {
  const table = italic ? BOLD_ITALIC : BOLD;
  let units = 0;
  for (const raw of text.toUpperCase()) {
    // É counts as E: the accent sits above, the width is the letter's
    const ch = raw.normalize('NFD').replace(/[̀-ͯ]/g, '') || raw;
    if (ch >= '0' && ch <= '9') {
      units += DIGIT;
    } else if (table[ch] != null) {
      units += table[ch];
    } else if ((ch.codePointAt(0) ?? 0) > 0xffff) {
      units += EMOJI;
    } else {
      units += OTHER;
    }
  }
  return units;
};

/** The headline row's width in points (PromoPopup's two Texts). */
export const headlineWidth = (
  lead: string,
  accent: string,
  size: number,
  fontScale = 1,
) => {
  const scale = (size * fontScale) / 1000;
  let width = 0;
  if (lead) {
    width += advance(lead, false) * scale + (accent ? PAD : 0);
  }
  if (accent) {
    width += (advance(accent, true) + TAIL) * scale + 2 * PAD;
  }
  return width;
};

export interface HeadlineLine {
  lead: string;
  accent: string;
}

export interface HeadlineFit {
  size: number;
  lines: HeadlineLine[];
}

// A point to spare: the phone rounds each text's width up to its pixels
const SLACK = 1;

/**
 * The size and lines for a headline: one line at the design's size if it
 * fits, else the largest whole size down to 28pt that fits, else two lines
 * at 28pt. Two lines break between the plain and the green part when both
 * fit, otherwise where the longer line is shortest. Wider still (64
 * characters a part), it takes as many lines at 28pt as it needs, and a
 * single word wider than the card ends in "…".
 */
export function fitHeadline(
  lead: string,
  accent: string,
  designSize: number,
  maxWidth: number,
  fontScale = 1,
): HeadlineFit {
  const fits = (l: string, a: string, size: number) =>
    headlineWidth(l, a, size, fontScale) + SLACK <= maxWidth;

  const smallest = Math.min(designSize, HEADLINE_MIN_SIZE);
  for (let size = designSize; size >= smallest; size--) {
    if (fits(lead, accent, size)) {
      return {size, lines: [{lead, accent}]};
    }
  }

  const size = smallest;
  const words = [
    ...lead.split(/\s+/).filter(Boolean).map(w => ({w, italic: false})),
    ...accent.split(/\s+/).filter(Boolean).map(w => ({w, italic: true})),
  ];
  const line = (from: number, to: number): HeadlineLine => {
    const part = words.slice(from, to);
    return {
      lead: part.filter(x => !x.italic).map(x => x.w).join(' '),
      accent: part.filter(x => x.italic).map(x => x.w).join(' '),
    };
  };
  const width = (l: HeadlineLine) =>
    headlineWidth(l.lead, l.accent, size, fontScale);
  const fitsLine = (l: HeadlineLine) => width(l) + SLACK <= maxWidth;

  if (lead && accent && fits(lead, '', size) && fits('', accent, size)) {
    const boundary = words.filter(x => !x.italic).length;
    return {size, lines: [line(0, boundary), line(boundary, words.length)]};
  }

  let best: HeadlineLine[] | null = null;
  let bestWidth = Infinity;
  for (let k = 1; k < words.length; k++) {
    const pair = [line(0, k), line(k, words.length)];
    const widest = Math.max(...pair.map(width));
    if (pair.every(fitsLine) && widest < bestWidth) {
      best = pair;
      bestWidth = widest;
    }
  }
  if (best) {
    return {size, lines: best};
  }

  // Longer than two lines: fill each line in turn
  const lines: HeadlineLine[] = [];
  let start = 0;
  for (let k = 1; k <= words.length; k++) {
    if (k > start + 1 && !fitsLine(line(start, k))) {
      lines.push(line(start, k - 1));
      start = k - 1;
    }
  }
  if (start < words.length) {
    lines.push(line(start, words.length));
  }
  return {size, lines};
}

// ── THE CLUBHOUSE SIDE ─────────────────────────────────────────────────────────────────────────────
// The design's size for offers and announcements (OfferPopup.tsx headlineSize={48}), and the width the preview's card
// has for it: the card at its full 312pt (a phone 376pt or wider), as the preview always draws it.
export const POPUP_HEADLINE_SIZE = 48;
export const PREVIEW_HEADLINE_WIDTH = headlineMaxWidth(10_000);
export const popupHeadlineFit = (lead: string, accent: string) => fitHeadline(lead, accent, POPUP_HEADLINE_SIZE, PREVIEW_HEADLINE_WIDTH);
// Shown smaller than the design: below 48pt, or on more than one line.
export const isShrunk = (f: HeadlineFit) => f.size < POPUP_HEADLINE_SIZE || f.lines.length > 1;
export const SHRINK_HINT = "Long title, shown smaller";

// The two parts as the popup draws them: an announcement's typed accent, else the app's split (the last word is the
// green one, "50% *OFF*"). {firstName} as the preview shows it.
export function splitHeadline(headline: string) {
  const words = headline.trim().split(/\s+/);
  if (words.length < 2) return { lead: words[0] ?? "", accent: "" };
  return { lead: words.slice(0, -1).join(" "), accent: words[words.length - 1] };
}
export function popupHeadlineParts(headline: string, typedAccent: string | null | undefined, announcement: boolean) {
  const h = withPreviewName(headline) ?? "";
  const a = typedAccent ? withPreviewName(typedAccent) : null;
  return announcement && a ? { lead: h.trim(), accent: a.trim() } : splitHeadline(h);
}
