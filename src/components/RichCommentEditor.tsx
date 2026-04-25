"use client";

import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  List,
  ListOrdered,
} from "lucide-react";

export default function RichCommentEditor({
  value,
  onChange,
  placeholder,
  onSubmit,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  onSubmit?: () => void;
}) {
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        code: false,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "",
      }),
    ],
    content: value,
    immediatelyRender: false,
    onUpdate({ editor }) {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class:
          "min-h-[80px] max-h-[240px] overflow-y-auto px-3 py-2 focus:outline-none prose prose-sm max-w-none text-deep-green",
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  useEffect(() => {
    if (!editor) return;
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onSubmitRef.current?.();
      }
    }
    const dom = editor.view.dom;
    dom.addEventListener("keydown", handleKey);
    return () => dom.removeEventListener("keydown", handleKey);
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="rounded-lg border border-cream-line bg-white transition-colors focus-within:border-mint">
      <div className="flex h-10 items-center gap-1 border-b border-cream-line px-2">
        <ToolbarBtn
          isActive={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          label="Bold"
        >
          <BoldIcon className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          isActive={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          label="Italic"
        >
          <ItalicIcon className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          isActive={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          label="Bullet list"
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          isActive={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          label="Numbered list"
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarBtn>
      </div>
      <EditorContent editor={editor} />
      <div className="border-t border-cream-line/40 px-3 py-1 text-[10px] text-deep-green/40">
        Cmd/Ctrl+Enter to post
      </div>
    </div>
  );
}

function ToolbarBtn({
  isActive,
  onClick,
  label,
  children,
}: {
  isActive: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={isActive}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        isActive
          ? "bg-mint text-deep-green"
          : "text-deep-green/70 hover:bg-cream-soft"
      }`}
    >
      {children}
    </button>
  );
}
