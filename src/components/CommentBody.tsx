"use client";

import { useEffect, useState } from "react";
import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["p", "strong", "em", "ul", "ol", "li", "br"];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default function CommentBody({ html }: { html: string }) {
  const [clean, setClean] = useState<string>("");

  useEffect(() => {
    const isPlainText = !html.includes("<");
    const source = isPlainText
      ? `<p>${escapeHtml(html).replace(/\n/g, "<br>")}</p>`
      : html;
    setClean(
      DOMPurify.sanitize(source, {
        ALLOWED_TAGS,
        ALLOWED_ATTR: [],
      }),
    );
  }, [html]);

  return (
    <div
      className="prose prose-sm max-w-none text-deep-green"
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
