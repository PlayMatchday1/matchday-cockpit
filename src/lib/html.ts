export function isEmptyHtml(html: string): boolean {
  if (!html) return true;
  const stripped = html.replace(/<[^>]*>/g, "").replace(/\s|&nbsp;/g, "");
  return stripped.length === 0;
}
