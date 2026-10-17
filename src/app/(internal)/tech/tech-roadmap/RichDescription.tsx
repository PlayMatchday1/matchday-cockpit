"use client";

// A card's description in the work panel: Markdown rendered for reading, and a small Tiptap editor
// (bold, italic, bullets, numbers, link) for writing. Both start from markdownToHtml in
// lib/richText.ts, so the editor opens on exactly what was shown. The editor saves Markdown through
// @tiptap/markdown, and only when the text was actually edited: opening and clicking away writes
// nothing.
//
// SANITISING. markdownToHtml already escapes raw HTML, but its output still goes through a private
// DOMPurify instance with an allowlist of the tags the editor can produce. Links keep only http,
// https and mailto, and open in a new tab. DOMPurify needs a DOM, so nothing is rendered on the server.

import { useEffect, useMemo, useRef, useState } from "react";
import createDOMPurify, { type DOMPurify } from "dompurify";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { markdownToHtml } from "@/lib/richText";

let purifier: DOMPurify | null = null;
function sanitize(html: string): string {
  if (!purifier) {
    purifier = createDOMPurify(window);
    purifier.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  return purifier.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "ul", "ol", "li", "a"],
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

// Shared look for the rendered text and the editor, so switching between them does not jump.
export const RICH_CSS = `
.rm-rich{font-size:14px;line-height:1.45;color:#0b2e22;word-break:break-word}
.rm-rich p{margin:0 0 6px}
.rm-rich p:last-child{margin-bottom:0}
.rm-rich ul,.rm-rich ol{margin:0 0 6px;padding-left:22px}
.rm-rich ul{list-style:disc}
.rm-rich ol{list-style:decimal}
.rm-rich li{margin:0 0 4px}
.rm-rich li::marker{color:#5d7a6f;font-weight:500}
.rm-rich li p{margin:0}
.rm-rich a{color:#288c5f;text-decoration:underline;text-underline-offset:2px}
.rm-rich .ProseMirror{outline:none;min-height:60px}
.rm-rich .ProseMirror p.is-editor-empty:first-child::before{content:attr(data-placeholder);color:#7d948a;float:left;height:0;pointer-events:none}
`;

// The panel only ever renders in the browser (it opens on a click), so sanitising during render is
// safe here and avoids a blank frame before the text appears. The guard keeps a server render inert.
export function DescriptionView({ md }: { md: string }) {
  const html = useMemo(() => (typeof window === "undefined" ? null : sanitize(markdownToHtml(md))), [md]);
  if (html === null) return null;
  return <div data-testid="description-view" className="rm-rich" dangerouslySetInnerHTML={{ __html: html }} />;
}

const TOOLS = [
  { key: "bold", label: "Bold", icon: "/roadmap/fmt-bold.svg" },
  { key: "italic", label: "Italic", icon: "/roadmap/fmt-italic.svg" },
  { key: "bullets", label: "Bulleted list", icon: "/roadmap/fmt-bullets.svg" },
  { key: "numbers", label: "Numbered list", icon: "/roadmap/fmt-numbers.svg" },
  { key: "link", label: "Link", icon: "/roadmap/fmt-link.svg" },
] as const;

/** The editor. `onDone` receives the new Markdown when the text changed, or null when it did not. */
export function DescriptionEditor({ md, onDone }: { md: string; onDone: (next: string | null) => void }) {
  const dirty = useRef(false);
  const done = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkRange = useRef<{ from: number; to: number } | null>(null);
  const [, force] = useState(0);
  const initialHtml = useMemo(() => sanitize(markdownToHtml(md)), [md]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, codeBlock: false, code: false, blockquote: false, horizontalRule: false,
        strike: false, underline: false,
        link: { openOnClick: false, autolink: false, linkOnPaste: true, defaultProtocol: "https", protocols: ["http", "https", "mailto"] },
      }),
      Markdown,
    ],
    content: initialHtml,
    immediatelyRender: false,
    autofocus: "end",
    onUpdate: () => { dirty.current = true; },
    onSelectionUpdate: () => force((n) => n + 1),
    onTransaction: () => force((n) => n + 1),
    editorProps: { attributes: { "data-testid": "description-editor", "aria-label": "Description" } },
  });

  // `autofocus` does not take here: with immediatelyRender off, the view attaches after the first
  // render, so focus stayed on the page and the first keystrokes went nowhere. Focus it once it exists.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.focus("end");
  }, [editor]);

  const finish = () => {
    if (done.current || !editor) return;
    done.current = true;
    onDone(dirty.current ? editor.getMarkdown().trim() : null);
  };

  // "Click away" means focus moved to something OUTSIDE the box (tabbing away). A blur with no
  // next target is not a click away: it is what the link field does as it closes and unmounts,
  // and treating it as one saved and closed the editor mid-edit. A real click on the page is
  // caught by the mousedown listener below instead.
  const onBlur = (e: React.FocusEvent) => {
    if (!(e.relatedTarget instanceof Node)) return;
    if (boxRef.current && boxRef.current.contains(e.relatedTarget)) return;
    finish();
  };
  // A click on the page that never takes focus (blank space, a non-focusable element) still counts.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && e.target instanceof Node && !boxRef.current.contains(e.target)) finish();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  const run = (key: (typeof TOOLS)[number]["key"]) => {
    if (!editor) return;
    const c = editor.chain().focus();
    if (key === "bold") c.toggleBold().run();
    else if (key === "italic") c.toggleItalic().run();
    else if (key === "bullets") c.toggleBulletList().run();
    else if (key === "numbers") c.toggleOrderedList().run();
    else {
      // Remember what was selected: the link field takes focus, and the editor's selection does
      // not reliably survive that.
      const { from, to } = editor.state.selection;
      linkRange.current = { from, to };
      setLinkUrl(String(editor.getAttributes("link").href ?? ""));
      setLinkOpen(true);
    }
  };
  const active = (key: (typeof TOOLS)[number]["key"]) =>
    !!editor && (key === "bold" ? editor.isActive("bold") : key === "italic" ? editor.isActive("italic")
      : key === "bullets" ? editor.isActive("bulletList") : key === "numbers" ? editor.isActive("orderedList") : editor.isActive("link"));

  // Back to the text, SYNCHRONOUSLY, before the link field unmounts. Tiptap's focus() waits for
  // the next animation frame: in that gap the closing field dropped focus to the page, and the
  // late focus then restored the old selection, so the next keystrokes overwrote the linked word.
  const backToText = () => {
    if (editor && !editor.isDestroyed) editor.view.focus();
  };
  const applyLink = () => {
    if (!editor) return;
    const url = linkUrl.trim();
    const r = linkRange.current;
    const c = editor.chain();
    if (r) c.setTextSelection(r);
    c.extendMarkRange("link");
    if (!url) c.unsetLink().run();
    else c.setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` }).run();
    // Carry on typing after the link, not over it.
    editor.commands.setTextSelection(editor.state.selection.to);
    backToText();
    setLinkOpen(false);
  };

  return (
    <div ref={boxRef} onBlur={onBlur} className="flex flex-col gap-2 rounded-[10px] border-2 bg-white p-3" style={{ borderColor: "#2cdb87" }} data-testid="description-box">
      <span className="text-[12px] font-semibold" style={{ color: "#5d7a6f" }}>Description</span>
      <div className="flex items-center gap-[2px] self-start rounded-[8px] p-[2px]" style={{ background: "#f3f4f0" }} role="toolbar" aria-label="Formatting">
        {TOOLS.map((t) => (
          <button key={t.key} type="button" aria-label={t.label} title={t.label} aria-pressed={active(t.key)} data-testid={`fmt-${t.key}`}
            onMouseDown={(e) => e.preventDefault()} onClick={() => run(t.key)}
            className="rounded-[6px] px-[7px] py-[6px]" style={{ background: active(t.key) ? "#ffffff" : "transparent" }}>
            <img src={t.icon} alt="" width={16} height={16} className="block" />
          </button>
        ))}
      </div>
      {linkOpen && (
        <div className="flex items-center gap-2">
          <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="Paste a link"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); backToText(); setLinkOpen(false); } }}
            data-testid="link-input" className="min-h-[30px] flex-1 rounded-[8px] border px-2 text-[13px]" style={{ borderColor: "#e0e0db" }} />
          <button type="button" onClick={applyLink} className="rounded-[8px] px-2.5 py-1 text-[12px] font-semibold text-white" style={{ background: "#063d2c" }}>Add link</button>
        </div>
      )}
      <div className="rm-rich"><EditorContent editor={editor} /></div>
    </div>
  );
}
