// Card descriptions on the Tech Roadmap are Markdown in data.description: bold, italic, bulleted
// and numbered lists, and links. Nothing else is FORMATTED. Anything else Markdown would recognise
// (a heading, a quote, code, a table, an image, raw HTML) is shown as the literal text that was
// typed, so a stray "#" or "<script>" reads as characters, never as structure or code.
//
// ONE PARSE FOR READING AND EDITING. The panel renders this HTML, and the editor is loaded from the
// same HTML, so what you open is what you saw. `breaks: true` matters: every description written
// before Roadmap 2.0 is plain text that uses single line breaks as structure ("Examples:\nCity\n
// Field"), and Markdown's default would join those lines with a space. Here a line break stays a
// line break, so the old text needs no migration.
//
// This module returns UNSANITISED HTML from markdownToHtml. Raw HTML in the source is already
// escaped by the renderer below, but the caller must still pass the result through DOMPurify (see
// RichDescription.tsx) before it reaches the DOM.

import { Marked, type Token, type Tokens } from "marked";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const asText = (raw: string) => `<p>${esc(raw.trim()).replace(/\n/g, "<br>")}</p>\n`;

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html: (t: Tokens.HTML | Tokens.Tag) => ("block" in t && t.block ? asText(t.raw) : esc(t.raw)),
    heading: (t: Tokens.Heading) => asText(t.raw),
    code: (t: Tokens.Code) => asText(t.raw),
    blockquote: (t: Tokens.Blockquote) => asText(t.raw),
    hr: (t: Tokens.Hr) => asText(t.raw),
    table: (t: Tokens.Table) => asText(t.raw),
    codespan: (t: Tokens.Codespan) => esc(t.raw),
    image: (t: Tokens.Image) => esc(t.raw),
    del: (t: Tokens.Del) => esc(t.raw),
    checkbox: (t: Tokens.Checkbox) => (t.checked ? "[x] " : "[ ] "),
  },
});

export function markdownToHtml(src: string): string {
  if (!src.trim()) return "";
  return md.parse(src, { async: false }) as string;
}

// ── the first line, as plain text ──────────────────────────────────────────
function inlineText(tokens: Token[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.type === "br") out += "\n";
    else if (t.type === "escape") out += (t as Tokens.Escape).text;
    else if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length) out += inlineText(t.tokens);
    else if (t.type === "list") out += inlineText((t as Tokens.List).items.slice(0, 1));
    else if ("text" in t && typeof t.text === "string") out += t.text;
    else out += t.raw;
  }
  return out;
}

/** What a card or a release row shows: the description's first line, formatting stripped. A list
 *  contributes its first item; "**Bold** start" becomes "Bold start". */
export function firstLinePlain(src: string | null | undefined): string {
  const s = String(src ?? "");
  if (!s.trim()) return "";
  const first = md.lexer(s).find((t) => t.type !== "space");
  if (!first) return "";
  const text = first.type === "list" ? inlineText((first as Tokens.List).items.slice(0, 1)) : inlineText([first]);
  return (text.split("\n").find((l) => l.trim()) ?? "").trim();
}
