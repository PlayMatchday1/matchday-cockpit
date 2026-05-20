import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import { SafeAreaInsetWatcher } from "@/components/SafeAreaInsetWatcher";

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
  title: "MD Clubhouse",
  description: "Internal ops dashboard for MatchDay.",
  // Web manifest for PWA install on iOS Safari + Android Chrome.
  // Served from public/manifest.json.
  manifest: "/manifest.json",
  // iOS Safari ignores manifest icons for the home-screen install,
  // it requires <link rel="apple-touch-icon">. Next's metadata API
  // surfaces these via `icons.apple`. Points at the root-level
  // /apple-touch-icon.png so iOS also picks it up via its default
  // auto-discovery path.
  icons: {
    icon: [
      { url: "/matchday-badge.svg", type: "image/svg+xml" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png" },
    ],
  },
  // Home-screen launcher title on iOS. Distinct from `<title>`
  // so the long form lives in the browser tab while the short
  // form fits under the icon.
  appleWebApp: {
    capable: true,
    title: "MD Clubhouse",
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
  // iOS Safari standalone PWA: resize the layout viewport when the
  // on-screen keyboard appears so dvh / env(safe-area-inset-*) stay
  // accurate through keyboard open/close cycles. Without this the
  // default "resizes-visual" leaves stale values after dismiss and
  // breaks fixed chrome (status-bar safe area collapses, body becomes
  // scrollable). Spec'd by the W3C virtual-keyboard proposal; iOS
  // 16.4+ and Chrome 108+.
  interactiveWidget: "resizes-content",
  // Lock zoom to 1. iOS Safari PWA in standalone mode honors
  // user-scalable=no; the bug surface here is the position:fixed
  // bottom nav re-anchoring to a zoomed visual viewport (which sits
  // partway up the layout viewport), stranding the nav mid-screen
  // until the user pinches back to 1. Accessibility tradeoff
  // accepted for an admin-gated internal tool; revisit if this app
  // ever surfaces to a public audience.
  maximumScale: 1,
  userScalable: false,
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
        <SafeAreaInsetWatcher />
      </body>
    </html>
  );
}
