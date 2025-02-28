import { Provider } from "@/components/ui/provider";
import { Theme } from "@chakra-ui/react";
import { Geist } from "next/font/google";
import "./globals.css";

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export const metadata = {
  metadataBase: new URL(defaultUrl),
  title: "PawtoGrader",
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
      <body className="bg-background text-foreground" style={{ overflow: 'hidden' }}>
            <Provider>
              <Theme appearance="light" colorPalette="teal">
              {children}
              </Theme></Provider>
      </body>
    </html>
  );
}
