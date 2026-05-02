// Slug generation for partner_dashboards. Format:
//
//   <kebab-of-name>-<8 unambiguous random chars>
//
// e.g. "PAC Global" → "pac-global-7vdybfv4". Used by the admin "Add
// Partner" modal and the "Regenerate slug" row action so both flows
// produce the same shape.
//
// The random suffix uses an alphabet that avoids visually ambiguous
// characters (no 0/O, 1/l/I) — slugs are sometimes shared verbally or
// over chat where a misread would 404 the partner.

const SUFFIX_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SUFFIX_LENGTH = 8;

export function kebabify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40); // cap to keep slugs reasonable
}

export function randomSuffix(length: number = SUFFIX_LENGTH): string {
  // crypto.getRandomValues is available in browsers + modern Node.
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SUFFIX_ALPHABET[buf[i] % SUFFIX_ALPHABET.length];
  }
  return out;
}

export function generateSlug(partnerName: string): string {
  const prefix = kebabify(partnerName);
  const suffix = randomSuffix();
  return prefix ? `${prefix}-${suffix}` : suffix;
}
