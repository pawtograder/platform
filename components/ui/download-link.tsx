"use client";

import { Link } from "@chakra-ui/react";
import * as React from "react";

export default function DownloadLink({
  href,
  filename,
  children,
  ...rest
}: {
  href: string;
  filename: string;
  children?: React.ReactNode;
} & React.ComponentProps<typeof Link>) {
  // Ensure the requested filename is used by adding the `download` query param
  // Supabase Storage honors this to set Content-Disposition filename
  let finalHref = href;
  try {
    const url = new URL(href);
    url.searchParams.set("download", filename);
    finalHref = url.toString();
  } catch {
    // If URL parsing fails (unlikely), fall back to the provided href
  }

  return (
    <Link href={finalHref} download={filename} {...rest}>
      {children || `Download ${filename}`}
    </Link>
  );
}
