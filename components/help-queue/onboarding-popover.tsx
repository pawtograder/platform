"use client";

import { PopoverArrow, PopoverBody, PopoverContent, PopoverRoot } from "@/components/ui/popover";
import { Popover, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

/**
 * An onboarding hint that opens next to `children` on its own, without the student clicking
 * anything. The student closes it by clicking anywhere on it, clicking outside it, or pressing
 * Escape. hooks/useOfficeHoursOnboarding.ts decides which hint is open.
 *
 * When `active` is false (the course hasn't turned the feature on, or the user isn't a student),
 * this renders `children` alone, so the page is the same as without the feature.
 */
export function OnboardingPopover({
  active,
  open,
  onDismiss,
  message,
  placement = "bottom",
  children
}: {
  active: boolean;
  open: boolean;
  onDismiss: () => void;
  message: ReactNode;
  placement?: "bottom" | "bottom-start" | "bottom-end";
  children: ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <PopoverRoot
      open={open}
      onOpenChange={({ open: stillOpen }) => {
        if (!stillOpen) onDismiss();
      }}
      positioning={{ placement }}
      // Leave focus where the student is. The hint is a pointer, not a form to fill in.
      autoFocus={false}
      // Focus is never inside the hint, so by default any focus change, such as pressing Tab, would
      // count as interacting outside it and close it. Only clicks outside it and Escape close it.
      onFocusOutside={(event) => event.preventDefault()}
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
