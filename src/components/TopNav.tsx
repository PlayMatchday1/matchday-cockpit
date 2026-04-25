"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Goals", match: (p: string) => p === "/" },
  {
    href: "/cities",
    label: "Cities",
    match: (p: string) => p.startsWith("/cities"),
  },
  {
    href: "/org",
    label: "Org",
    match: (p: string) => p.startsWith("/org"),
  },
  {
    href: "/data",
    label: "Data",
    match: (p: string) => p.startsWith("/data"),
  },
  { href: "/docs", label: "Docs", match: (p: string) => p.startsWith("/docs") },
];

export default function TopNav() {
  const pathname = usePathname();

  return (
    <header className="bg-deep-green text-cream">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2" aria-label="MatchDay home">
            <Image
              src="/matchday-logo.png"
              alt="MatchDay"
              width={140}
              height={32}
              priority
              className="h-7 w-auto"
            />
          </Link>
          <nav className="flex gap-1">
            {TABS.map((tab) => {
              const active = tab.match(pathname);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium tracking-tight transition ${
                    active
                      ? "bg-mint text-deep-green"
                      : "text-cream/80 hover:bg-deep-green-soft hover:text-cream"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
}
