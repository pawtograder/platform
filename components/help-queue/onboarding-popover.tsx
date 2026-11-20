"use client";

import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot } from "@/components/ui/popover";
import { Popover, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

/**
 * An onboarding hint that opens next to `children` on its own, without the student clicking
 * anything. The student closes it by clicking anywhere on it, clicking outside it, or pressing
 * Escape. hooks/useOfficeHoursOnboarding.ts decides which hint is open.
 */
export function OnboardingPopover({
  open,
  onDismiss,
  message,
  placement = "bottom",
  children
}: {
  open: boolean;
  onDismiss: () => void;
  message: string;
  placement?: "bottom" | "bottom-start" | "bottom-end";
  children: ReactNode;
}) {
  return (
    <PopoverRoot
      open={open}
      onOpenChange={({ open: stillOpen }) => {
        if (!stillOpen) onDismiss();
      }}
      positioning={{ placement }}
      // Leave focus where the student is. The hint is a pointer, not a form to fill in.
      autoFocus={false}
      lazyMount
      unmountOnExit
    >
      <Popover.Anchor asChild>{children}</Popover.Anchor>
      <PopoverContent maxW="xs" cursor="pointer" onClick={onDismiss}>
        <PopoverArrow />
        <PopoverBody>
          <Text fontSize="sm">{message}</Text>
          <Text fontSize="xs" color="fg.muted" mt={2}>
            Click to dismiss
          </Text>
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}
