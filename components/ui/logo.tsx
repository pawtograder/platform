"use client";

import { useColorMode } from "@/components/ui/color-mode";
import { useBranding } from "@/components/branding/branding-provider";
import Image from "next/image";

/** True for absolute http(s) URLs (custom-hosted logos), false for bundled paths. */
function isRemote(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/**
 * Brand logo, color-mode aware. Source and alt text come from the deployment
 * branding (see lib/branding.ts), so self-hosted installs can swap the logo via
 * env without rebuilding. Local/bundled paths go through next/image; absolute
 * URLs (custom-hosted logos) render with a plain <img> so they don't require
 * next.config image host allow-listing.
 */
export default function Logo({ width, alt }: { width: number; alt?: string }) {
  const { colorMode } = useColorMode();
  const branding = useBranding();
  const src = colorMode === "dark" ? branding.logoDark : branding.logoLight;
  const label = alt ?? branding.name;

  if (isRemote(src)) {
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary external brand URL; next/image would need per-host config
    return <img src={src} width={width} height={width} alt={label} style={{ width, height: "auto" }} />;
  }

  return <Image src={src} width={width} height={width} alt={label} />;
}
