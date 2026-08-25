import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sinter Cloud",
  description: "Encrypted session continuity across your devices.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
