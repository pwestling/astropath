import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Astropath — your agent workspace",
  description:
    "A private workspace for messages, files, and shared context across your agents.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
