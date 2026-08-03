/**
 * Regression test for issue #881 finding 3.
 *
 * VoiceOver announced the global toast region as "bottom-end Notifications
 * alt+T": @zag-js/toast builds the group's accessible name by concatenating the
 * placement token, a label and its focus hotkey
 * (`aria-label: `${placement} ${label} ${hotkeyLabel}``). The placement token is
 * an implementation detail and the hotkey is not ours to advertise, so
 * components/ui/toaster.tsx passes an explicit `aria-label` — Ark merges caller
 * props over the generated ones.
 */
import { render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { Toaster } from "@/components/ui/toaster";

describe("global toast region (issue #881)", () => {
  it("is named just 'Notifications', with no placement token or hotkey", () => {
    render(
      <ChakraProvider value={defaultSystem}>
        <Toaster />
      </ChakraProvider>
    );

    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveAttribute("aria-label", "Notifications");
    expect(region.getAttribute("aria-label")).not.toMatch(/bottom|end|alt/i);
  });
});
