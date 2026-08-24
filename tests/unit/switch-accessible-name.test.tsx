/**
 * `components/ui/switch.tsx` renders its visible text as a plain `<span>`
 * carrying `getLabelProps()` rather than as a `Switch.Label`, so that Chakra's
 * `Root` stays the only `<label>` for the hidden input. A side effect is that
 * the input's `aria-labelledby` — which Zag emits unconditionally — resolves
 * for the first time, and therefore outranks anything else.
 *
 * That is easy to regress in either direction: a Chakra or Zag upgrade that
 * stops emitting the id, or a caller who reaches for `aria-label` to append an
 * explanation and silently shortens or lengthens the name instead. Both shapes
 * are pinned here, in a suite that runs on every PR, because the opt-in
 * coverage sweep only checks that a name exists and not what it says.
 *
 * These assertions use jest-dom's accessible-name computation rather than
 * reading attributes, so they describe what assistive technology announces.
 */
import { ChakraProvider } from "@chakra-ui/react";
import { render } from "@testing-library/react";
import { system } from "@/components/ui/theme";
import { Switch } from "@/components/ui/switch";

function renderSwitch(ui: React.ReactElement): HTMLInputElement {
  render(<ChakraProvider value={system}>{ui}</ChakraProvider>);
  const input = document.querySelector("input[type='checkbox']");
  if (!input) throw new Error("Switch rendered no hidden input");
  return input as HTMLInputElement;
}

describe("Switch accessible name", () => {
  it("names the control from its visible text", () => {
    const input = renderSwitch(<Switch>Enter to send</Switch>);
    expect(input).toHaveAccessibleName("Enter to send");
  });

  it("resolves every aria-labelledby id it advertises", () => {
    const input = renderSwitch(<Switch>Enter to send</Switch>);
    const ids = (input.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    // A dangling reference is the failure this component exists to prevent:
    // it leaves the switch with no name at all in some AT, and the name is
    // computed from a fallback in others, so the two disagree.
    for (const id of ids) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it("carries a description without letting it swallow the name", () => {
    // The shape code-file.tsx uses. The explanation has to be announced, but
    // it must not become the name: a name is what AT reads when it lists the
    // form controls on a page, and a sentence is unusable there.
    // The hint is a sibling, not a child: anything inside `children` is part
    // of the label span and joins the name.
    const input = renderSwitch(
      <>
        <Switch inputProps={{ "aria-describedby": "hint" }}>New editor view</Switch>
        <span id="hint">Turn off for a plain text code view.</span>
      </>
    );
    expect(input).toHaveAccessibleName("New editor view");
    expect(input).toHaveAccessibleDescription("Turn off for a plain text code view.");
  });

  it("still honors aria-label when there is no visible text", () => {
    // Switches with no children render no label span, so the reference
    // dangles and the name falls through to the wrapping <label>. Three LTI
    // switches depend on this, so it is behavior and not an accident.
    const input = renderSwitch(<Switch aria-label="Roster sync for CS 3200" />);
    expect(input).toHaveAccessibleName("Roster sync for CS 3200");
  });
});
