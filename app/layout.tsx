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
import StaleBundleRecovery from "@/components/StaleBundleRecovery";
import CorruptSessionRecovery from "@/components/CorruptSessionRecovery";
import { Toaster } from "@/components/ui/toaster";
import { BrandingProvider } from "@/components/branding/branding-provider";
import { getBranding } from "@/lib/branding";
const defaultUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";

export async function generateMetadata() {
  const branding = getBranding();
  return {
    metadataBase: new URL(defaultUrl),
    title: branding.name,
    description: branding.description,
    // Drives the browser-tab favicon from branding so deployments can swap it
    // without rebuilding (replaces the app/favicon.ico + app/icon.svg file
    // conventions, now moved to public/). Point BRAND_FAVICON at a bundled path
    // (e.g. /branding/favicon.png) or an absolute URL.
    icons: { icon: branding.favicon }
  };
}

const geistSans = GeistSans;

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  // CSP nonce set by middleware; passed to next-themes so its bootstrap
  // <script> isn't blocked under the strict script-src policy.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // Deployment branding is resolved server-side and handed to the client via
  // BrandingProvider so the same image can be re-skinned purely by env.
  const branding = getBranding();
  return (
    <html lang="en" className={geistSans.className} suppressHydrationWarning>
      <body className="bg-background text-foreground">
        <Provider nonce={nonce}>
          <BrandingProvider branding={branding}>
            <Theme colorPalette={branding.colorPalette}>
              <SkipNav />
              <ClientOnly>
                <Toaster />
                <ColorModeWatcher />
                <StaleBundleRecovery />
                <CorruptSessionRecovery />
              </ClientOnly>
              <LiveAnnouncer>{children}</LiveAnnouncer>
            </Theme>
          </BrandingProvider>
        </Provider>
      </body>
    </html>
  );
}
