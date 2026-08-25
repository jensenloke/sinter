import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sinter Cloud",
  description: "Encrypted session continuity across your devices.",
  icons: {
    icon: [
      { url: "/brand/sinter-mark-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/sinter-mark-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/brand/sinter-mark-192.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
