"use client";

import { useGlobalSearch } from "@/components/ui/global-search";
import { Button, HStack, Kbd, Text } from "@chakra-ui/react";
import * as React from "react";
import { BsSearch } from "react-icons/bs";

const isMacUA = () =>
  typeof navigator !== "undefined" && /Mac|iPad|iPhone|iPod/i.test(navigator.platform || navigator.userAgent || "");

/**
 * Visible trigger for the global search palette. Sits in the course nav
 * next to the user menu. Shows the ⌘K / Ctrl+K shortcut so the keyboard
 * affordance is discoverable. Styled like a search input so it reads as
 * a search affordance rather than a button.
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
      alignItems="center"
      justifyContent="space-between"
      width={{ base: "auto", md: "240px", lg: "320px" }}
      maxWidth="100%"
      px={3}
      fontWeight="normal"
    >
      <HStack gap={2} color="fg.muted">
        <BsSearch aria-hidden />
        <Text display={{ base: "none", md: "inline" }}>Search…</Text>
      </HStack>
      <Kbd aria-hidden display={{ base: "none", lg: "inline-flex" }}>
        {isMac ? "⌘K" : "Ctrl+K"}
      </Kbd>
    </Button>
  );
}
