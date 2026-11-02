// COPY TEXT TO THE CLIPBOARD, with a fallback for older Safari (iPhone). Resolves true only when a
// copy actually happened; the caller shows "Copied" on true and a failure on false — never a tick
// for something that did not happen (the rule CopyPhone.tsx states).
//
// navigator.clipboard.writeText first. If it is missing or rejects, a hidden readonly textarea +
// document.execCommand("copy"): iOS needs the element selectable (contentEditable, a real range,
// setSelectionRange) and at least 16px text, or it zooms the page. Must be called from a click.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.contentEditable = "true";
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;";
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    sel?.removeAllRanges();
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
