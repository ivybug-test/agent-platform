import Providers from "@/components/Providers";
import "./globals.css";
import type { Viewport } from "next";

export const metadata = {
  title: "Agent Platform",
  description: "Agent chat platform",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
