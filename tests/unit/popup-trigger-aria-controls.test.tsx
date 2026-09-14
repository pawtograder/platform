/**
 * The student a11y sweep resolves `aria-controls` on popup triggers itself
 * rather than baselining axe's "unable to determine" verdict (see
 * `tests/e2e/a11y/scan.ts`). That is only sound while the app's popup triggers
 * really do reference something: a closed Chakra popover keeps its content in
 * the DOM, and drops `aria-controls` entirely in the `lazyMount unmountOnExit`
 * case where it does not.
 *
 * These tests pin that invariant at the wrapper level, so a Chakra upgrade that
 * starts leaving dangling references fails here — in a suite that runs on every
 * PR — instead of only in the opt-in sweep.
 */
import { ChakraProvider, Button } from "@chakra-ui/react";
import { render } from "@testing-library/react";
import { system } from "@/components/ui/theme";
import { DialogBody, DialogContent, DialogRoot, DialogTrigger } from "@/components/ui/dialog";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@/components/ui/menu";
import { PopoverBody, PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/popover";

function renderClosed(ui: React.ReactElement) {
  render(<ChakraProvider value={system}>{ui}</ChakraProvider>);
  const trigger = document.querySelector("[aria-haspopup]");
  if (!trigger) throw new Error("no popup trigger rendered");
  return trigger;
}

/** Readable summary of what aria-controls points at, for assertion messages. */
function controlsResolution(trigger: Element): string {
  const value = trigger.getAttribute("aria-controls");
  if (value === null) return "absent";
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => `${id}=${document.getElementById(id) ? "resolves" : "MISSING"}`)
    .join(" ");
}

/** Every id in aria-controls must resolve; no attribute at all is also fine. */
function expectNoDanglingControls(trigger: Element) {
  expect(controlsResolution(trigger)).not.toContain("MISSING");
}

describe("closed popup triggers do not leave a dangling aria-controls", () => {
  it("popover", () => {
    expectNoDanglingControls(
      renderClosed(
        <PopoverRoot>
          <PopoverTrigger asChild>
            <Button>open</Button>
          </PopoverTrigger>
          <PopoverContent>
            <PopoverBody>body</PopoverBody>
          </PopoverContent>
        </PopoverRoot>
      )
    );
  });

  it("popover with lazyMount unmountOnExit", () => {
    const trigger = renderClosed(
      <PopoverRoot lazyMount unmountOnExit>
        <PopoverTrigger asChild>
          <Button>open</Button>
        </PopoverTrigger>
        <PopoverContent>
          <PopoverBody>body</PopoverBody>
        </PopoverContent>
      </PopoverRoot>
    );
    // Nothing is mounted to point at, so the attribute has to be gone.
    expect(trigger.getAttribute("aria-controls")).toBeNull();
  });

  it("menu", () => {
    expectNoDanglingControls(
      renderClosed(
        <MenuRoot>
          <MenuTrigger asChild>
            <Button>open</Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem value="a">A</MenuItem>
          </MenuContent>
        </MenuRoot>
      )
    );
  });

  it("dialog", () => {
    expectNoDanglingControls(
      renderClosed(
        <DialogRoot>
          <DialogTrigger asChild>
            <Button>open</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogBody>body</DialogBody>
          </DialogContent>
        </DialogRoot>
      )
    );
  });
});
