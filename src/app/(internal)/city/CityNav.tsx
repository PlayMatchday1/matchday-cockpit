"use client";

// The city-manager tier's navigation. It did not exist before Phase 29 because the tier had
// exactly one page; Reviews is the second, so there is now something to navigate between.
//
// The Reviews item appears ONLY because /api/reviews scopes on the server. A nav item pointing at
// a page that filters in the browser would be worse than no nav item — it would look like a
// feature and behave like a data leak.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { cityNameFor } from "@/lib/cityScope";

// THREE items, FLAT — no Daily Ops / Back Office switch. That switch exists to divide a large
// estate; this tier has three pages, and a section toggle over three items is chrome pretending
// to be structure. Order is deliberate: Manager Pay is the primary page and the only one carrying
// a write (the manager assignment).
const ITEMS = [
  { href: "/city/manager-pay", label: "Manager Pay" },
  { href: "/city/reviews", label: "Reviews" },
  { href: "/city/gameday", label: "Gameday Ops" },
];

export default function CityNav() {
  const pathname = usePathname() ?? "";
  const { appUser } = useAuth();
  const city = cityNameFor(appUser?.city_identifier) ?? appUser?.city_identifier ?? null;
  return (
    <nav className="cnav" data-testid="city-nav" aria-label="City manager">
      <style>{CSS}</style>
      <span className="cnav-city" data-testid="city-nav-scope">{city ?? "No city"}</span>
      {ITEMS.map((i) => {
        const on = pathname === i.href || pathname.startsWith(i.href + "/");
        return (
          <Link key={i.href} href={i.href} data-testid={`city-nav-${i.label.toLowerCase().replace(/ /g, "-")}`}
            aria-current={on ? "page" : undefined} className={on ? "on" : ""}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}

const CSS = `
.cnav{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:10px 0 14px;
  font:14px/1.4 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.cnav-city{font-size:10px;font-weight:800;letter-spacing:.11em;color:#5c7168;background:#eef4f1;
  border:1px solid #cbd8d1;border-radius:6px;padding:4px 9px;margin-right:8px}
.cnav a{display:inline-flex;align-items:center;min-height:38px;padding:0 14px;border-radius:9px;
  text-decoration:none;font-weight:700;font-size:13.5px;color:#3d5349;border:1px solid transparent}
.cnav a:hover{background:#f2f7f4}
.cnav a.on{background:#e7efe9;border-color:#cbd8d1;color:#0e1a13}
`;
