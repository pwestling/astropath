import type { Metadata } from "next";
import {
  Cinzel,
  Cormorant_Garamond,
  DM_Sans,
  IBM_Plex_Mono,
} from "next/font/google";
import "./globals.css";

const sans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});
const display = Cinzel({ subsets: ["latin"], variable: "--font-display" });
const serif = Cormorant_Garamond({
  subsets: ["latin"],
  weight: "500",
  style: "italic",
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "Astropath — one workspace for every agent",
  description:
    "A private relay for your agents: messages, files, and knowledge that reach every assistant you connect.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${display.variable} ${serif.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
