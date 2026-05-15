"use client";

import { useGlobalSearch } from "@/components/ui/global-search";
import { Button, Kbd } from "@chakra-ui/react";
import * as React from "react";
import { BsSearch } from "react-icons/bs";

const isMacUA = () =>
  typeof navigator !== "undefined" && /Mac|iPad|iPhone|iPod/i.test(navigator.platform || navigator.userAgent || "");

/**
 * Visible trigger for the global search palette. Sits in the course nav
 * next to the user menu. Shows the ⌘K / Ctrl+K shortcut so the keyboard
 * affordance is discoverable.
 */
export function GlobalSearchTrigger() {
  const { open } = useGlobalSearch();
  const [isMac, setIsMac] = React.useState(false);
  React.useEffect(() => setIsMac(isMacUA()), []);

  return (
    <Button
      onClick={open}
      variant="outline"
      colorPalette="gray"
      size="sm"
      aria-label="Open search"
      display="inline-flex"
      gap={2}
      alignItems="center"
      px={{ base: 2, lg: 3 }}
    >
      <BsSearch aria-hidden />
      <Kbd aria-hidden display={{ base: "none", lg: "inline-flex" }}>
        {isMac ? "⌘" : "Ctrl"}K
      </Kbd>
    </Button>
  );
}
