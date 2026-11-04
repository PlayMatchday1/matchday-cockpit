// Builds src/lib/data/us-zip-towns.json from the GeoNames US postal code file (CC BY 4.0, https://www.geonames.org/,
// download.geonames.org/export/zip/US.zip). node scripts/build-zip-towns.mjs /path/to/US.txt
// Output: { "78641": "Leander|TX", ... }, one entry per ZIP (GeoNames' place name and state code). Rebuild by hand when
// a venue's ZIP is missing; the feed falls back to no town, never to a guess.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const src = process.argv[2];
if (!src) { console.error("usage: node scripts/build-zip-towns.mjs US.txt"); process.exit(2); }
const out = {}; let rows = 0, dup = 0;
for (const line of readFileSync(src, "utf8").split("\n")) {
  const c = line.split("\t"); if (c.length < 5 || c[0] !== "US") continue;
  const zip = c[1].trim(), place = c[2].trim(), st = c[4].trim();
  if (!/^\d{5}$/.test(zip) || !place || !/^[A-Z]{2}$/.test(st)) continue;
  rows++; if (out[zip]) { dup++; continue; }
  out[zip] = `${place}|${st}`;
}
mkdirSync(new URL("../src/lib/data/", import.meta.url), { recursive: true });
const dest = new URL("../src/lib/data/us-zip-towns.json", import.meta.url);
writeFileSync(dest, JSON.stringify(out));
console.log(`rows ${rows}, zips ${Object.keys(out).length}, duplicate zips skipped ${dup}, bytes ${readFileSync(dest).length}`);
