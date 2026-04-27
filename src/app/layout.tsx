import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AuthGate from "@/components/AuthGate";

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
};

// theme-color belongs on the Viewport export in Next 14+; setting it
// inside metadata is deprecated.
export const viewport: Viewport = {
  themeColor: "#003326",
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
      <head>
        <link
          rel="icon"
          type="image/svg+xml"
          href="/matchday-badge.svg"
        />
      </head>
      <body className="min-h-full">
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
