import "server-only"; // no-op under --conditions=react-server
// THE PLAYBOOK THE MODEL READS IS THE FILE STAFF READ: docs/support/PLAYBOOK.md, sections 1 to 3.
// One source, so the drafts cannot drift from the document Ryan edits. Section 4 (history of what
// the team used to do, including replies that broke the rules) and anything after it are cut off
// here and never sent — showing the model the old refunds would teach it the old refunds.
//
// The file ships with the ai-draft route through `outputFileTracingIncludes` in next.config.ts.
// If it is missing at runtime the route refuses to draft rather than drafting without rules.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLAYBOOK_PATH = "docs/support/PLAYBOOK.md";

export function playbookForModel(markdown: string): string {
  const cut = markdown.search(/^## 4\./m);
  return (cut === -1 ? markdown : markdown.slice(0, cut)).trim();
}

let cached: { text: string; version: string } | null = null;

export function loadPlaybook(): { text: string; version: string } {
  if (cached) return cached;
  const text = playbookForModel(readFileSync(join(process.cwd(), PLAYBOOK_PATH), "utf8"));
  if (!/^## 1\./m.test(text)) throw new Error("PLAYBOOK.md has no section 1; refusing to draft without house rules.");
  cached = { text, version: createHash("sha256").update(text).digest("hex").slice(0, 12) };
  return cached;
}
