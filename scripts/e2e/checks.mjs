// Reusable Playwright assertions, run in the browser via page.evaluate.
// Pure browser functions (no Node closures) so they serialize correctly.

// contrast(page): every visible element with a direct text child, ratio of its
// computed color vs its EFFECTIVE background (walk ancestors to the first
// background-color with alpha > 0.85, default white). Returns { min, failures }.
export async function contrast(page) {
  return page.evaluate(() => {
    const parseColor = (s) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map((x) => parseFloat(x.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    };
    const lin = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };
    const effectiveBg = (el) => {
      let n = el;
      while (n && n.nodeType === 1) {
        const c = parseColor(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.85) return c;
        n = n.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const hasDirectText = (el) =>
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
      return el.offsetParent !== null || s.position === "fixed";
    };

    const failures = [];
    let min = Infinity, minNode = null;
    for (const el of document.querySelectorAll("body *")) {
      if (!hasDirectText(el) || !visible(el)) continue;
      const fg = parseColor(getComputedStyle(el).color);
      if (!fg) continue;
      const bg = effectiveBg(el);
      const r = ratio(fg, bg);
      const rec = {
        ratio: Math.round(r * 100) / 100,
        text: el.textContent.trim().slice(0, 40),
        cls: (el.getAttribute("class") || "").slice(0, 60),
        tag: el.tagName.toLowerCase(),
      };
      if (r < min) { min = Math.round(r * 100) / 100; minNode = rec; }
      if (r < 4.5) failures.push(rec);
    }
    failures.sort((a, b) => a.ratio - b.ratio);
    return { min, minNode, failures };
  });
}

// warmBg(page): every element whose COMPUTED background resolves to a light warm
// colour (red − blue ≥ 8, all channels > 200, alpha > 0). After a sage re-theme
// the only survivors should be meaningful (gold / city / error) — this lists them
// so each can be confirmed as intentional, not a missed neutral.
export async function warmBg(page) {
  return page.evaluate(() => {
    const out = new Map();
    for (const el of document.querySelectorAll("body *")) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const p = m[1].split(",").map((x) => parseFloat(x.trim()));
      const [r, g, b, a = 1] = p;
      if (a > 0 && r - b >= 8 && r > 200 && g > 200 && b > 200) {
        const key = `${r},${g},${b}`;
        if (!out.has(key)) out.set(key, { rgb: key, cls: (el.getAttribute("class") || "").slice(0, 50) });
      }
    }
    return [...out.values()];
  });
}

// overflow(page): at the caller's viewport (set to 1600 before calling), assert
// documentElement.scrollWidth === clientWidth, and list elements that overflow
// their own box (intentional internal scrollers vs a page-level leak).
export async function overflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const s = getComputedStyle(el);
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute("class") || "").slice(0, 60),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowX: s.overflowX, // 'auto'/'scroll' = intentional scroller
        });
      }
    }
    return {
      pageScrollWidth: de.scrollWidth,
      pageClientWidth: de.clientWidth,
      pageLeak: de.scrollWidth > de.clientWidth + 1,
      offenders,
    };
  });
}
