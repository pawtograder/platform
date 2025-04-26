import { Provider } from "@/components/ui/provider";
import { Theme } from "@chakra-ui/react";
import { Geist } from "next/font/google";
import "./globals.css";
import { ColorModeWatcher } from "@/components/ui/color-mode";

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export const metadata = {
  metadataBase: new URL(defaultUrl),
  title: "Pawtograder",
  description: "Pawtograder is an application for managing student assignments",
};

const geistSans = Geist({
  display: "swap",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={geistSans.className} suppressHydrationWarning>
      <body className="bg-background text-foreground">
            <Provider>
              <Theme colorPalette="gray">
                <ColorModeWatcher />
              {children}
              </Theme></Provider>
      </body>
    </html>
  );
}
