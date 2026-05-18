import { Provider } from "@/components/ui/provider";
import { Theme, ClientOnly } from "@chakra-ui/react";
import { GeistSans } from "geist/font/sans";
import { headers } from "next/headers";
import "./globals.css";
import "katex/dist/katex.min.css";
import "@uiw/react-markdown-preview/markdown.css";
import "@uiw/react-md-editor/markdown-editor.css";
import { ColorModeWatcher } from "@/components/ui/color-mode";
import { LiveAnnouncer } from "@/components/ui/live-announcer";
import SkipNav from "@/components/ui/skip-nav";
import { Toaster } from "@/components/ui/toaster";
const defaultUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";

export const metadata = {
  metadataBase: new URL(defaultUrl),
  title: "Pawtograder",
  description: "Pawtograder is an application for managing student assignments"
};

const geistSans = GeistSans;

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  // CSP nonce set by middleware; passed to next-themes so its bootstrap
  // <script> isn't blocked under the strict script-src policy.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={geistSans.className} suppressHydrationWarning>
      <body className="bg-background text-foreground">
        <Provider nonce={nonce}>
          <Theme colorPalette="gray">
            <SkipNav />
            <ClientOnly>
              <Toaster />
              <ColorModeWatcher />
            </ClientOnly>
            <LiveAnnouncer>{children}</LiveAnnouncer>
          </Theme>
        </Provider>
      </body>
    </html>
  );
}
