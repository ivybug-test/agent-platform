import Providers from "@/components/Providers";
import "./globals.css";
import type { Viewport } from "next";

export const metadata = {
  title: "Agent 平台",
  description: "Agent 聊天平台",
};

// Declare the app as dark-only at the meta layer too. Without this, some
// mobile browsers (notably Huawei's HarmonyOS browser / Quark) render form
// controls and scrollbars in light mode even when our CSS is dark, and
// compound with the oklch fallback issue into the "white sidebar" bug.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#111111",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // data-theme on <html> so DaisyUI's [data-theme="dark"] CSS variables
  // resolve for every descendant — previously this attribute only lived on
  // nested component divs, which on older browsers can leave deep children
  // without the theme vars cascaded in.
  return (
    <html lang="zh-CN" data-theme="dark" style={{ colorScheme: "dark" }}>
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
