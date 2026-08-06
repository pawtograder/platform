import { Switch as ChakraSwitch } from "@chakra-ui/react";
import * as React from "react";

export interface SwitchProps extends ChakraSwitch.RootProps {
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  rootRef?: React.RefObject<HTMLLabelElement>;
  trackLabel?: { on: React.ReactNode; off: React.ReactNode };
  thumbLabel?: { on: React.ReactNode; off: React.ReactNode };
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch(props, ref) {
  const { inputProps, children, rootRef, trackLabel, thumbLabel, ...rest } = props;

  // Chakra's `ChakraSwitch.Root` renders as a `<label>` that already provides
  // the implicit label for the nested `HiddenInput`. Adding `ChakraSwitch.Label`
  // *inside* the same Root produces a second `<label for=...>` pointing at the
  // same input, which WAVE flags as "multiple form labels" and axe surfaces as
  // a duplicate accessible name. Render the visible text as a non-`<label>`
  // sibling so only Root labels the input.
  //
  // The Root still advertises `aria-labelledby="switch:…:label"` unconditionally,
  // so the span has to carry that id or the reference dangles and the control
  // has no accessible name (4.1.2). `getLabelProps()` is what `Switch.Label`
  // itself spreads — id and data-attrs, no element type — so taking it here
  // resolves the reference without adding a second `<label>`.
  return (
    <ChakraSwitch.Root ref={rootRef} {...rest}>
      <ChakraSwitch.HiddenInput ref={ref} {...inputProps} />
      {/* Keyboard focus lives on the visually-hidden input, so without a ring
          on the visible control there is no focus indicator at all (WCAG
          2.4.7). _focusVisible also matches Zag's [data-focus-visible], which
          the switch machine sets on the control while the input has keyboard
          focus. */}
      <ChakraSwitch.Control _focusVisible={{ outline: "2px solid", outlineColor: "blue.500", outlineOffset: "2px" }}>
        <ChakraSwitch.Thumb>
          {thumbLabel && (
            <ChakraSwitch.ThumbIndicator fallback={thumbLabel?.off}>{thumbLabel?.on}</ChakraSwitch.ThumbIndicator>
          )}
        </ChakraSwitch.Thumb>
        {trackLabel && <ChakraSwitch.Indicator fallback={trackLabel.off}>{trackLabel.on}</ChakraSwitch.Indicator>}
      </ChakraSwitch.Control>
      {children != null && (
        <ChakraSwitch.Context>
          {(api) => (
            <span {...api.getLabelProps()} data-part="label">
              {children}
            </span>
          )}
        </ChakraSwitch.Context>
      )}
    </ChakraSwitch.Root>
  );
});
