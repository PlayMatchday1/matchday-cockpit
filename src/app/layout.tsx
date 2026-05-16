import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";

// Root layout: HTML shell + fonts + PWA shell only. Authentication
// and internal nav live inside `(internal)/layout.tsx` so
// unauthenticated routes (login/, auth/, partners/) never inherit
// the AuthGate provider.

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bebas = Bebas_Neue({
  variable: "--font-bebas",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "MatchDay Clubhouse",
  description: "Internal ops dashboard for MatchDay.",
  // Web manifest for PWA install on iOS Safari + Android Chrome.
  // Served from public/manifest.json.
  manifest: "/manifest.json",
  // iOS Safari ignores manifest icons for the home-screen install —
  // it requires <link rel="apple-touch-icon">. Next's metadata API
  // surfaces these via `icons.apple`. The 180×180 covers iPhone
  // retina; iPad sizes (152/167) are deferred to a future enhance-
  // ment (operators are iPhone-only per Phase 1 scope).
  icons: {
    icon: [
      { url: "/matchday-badge.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon-180.png", sizes: "180x180" },
    ],
  },
  // Home-screen launcher title on iOS. Distinct from `<title>`
  // so the long form lives in the browser tab while the short
  // form fits under the icon.
  appleWebApp: {
    capable: true,
    title: "MatchDay",
    // black-translucent lets the dark-green TopNav extend up
    // behind the iPhone status bar area when launched from
    // Home Screen. Operators see a continuous green chrome
    // instead of a white system bar above the nav.
    statusBarStyle: "black-translucent",
  },
  // Stops iOS Safari from auto-linking phone numbers as tappable
  // tel: links in message bubble bodies + audit log views.
  formatDetection: { telephone: false },
};

// theme-color and viewport-fit belong on the Viewport export in
// Next 14+. viewport-fit=cover is the iOS-notch handler that pairs
// with the black-translucent status bar style above.
export const viewport: Viewport = {
  themeColor: "#003326",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bebas.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
