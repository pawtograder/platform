import { Checkbox as ChakraCheckbox } from "@chakra-ui/react";
import * as React from "react";

export interface CheckboxProps extends Omit<ChakraCheckbox.RootProps, "defaultChecked"> {
  icon?: React.ReactNode;
  /** Hidden input props *except* checked/defaultChecked to prevent duplication */
  inputProps?: Omit<React.InputHTMLAttributes<HTMLInputElement>, "checked" | "defaultChecked">;
  rootRef?: React.Ref<HTMLLabelElement>;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ icon, children, inputProps, rootRef, ...rest }, ref) => (
    <ChakraCheckbox.Root ref={rootRef} {...rest}>
      <ChakraCheckbox.HiddenInput ref={ref} {...inputProps} />
      <ChakraCheckbox.Control>{icon ?? <ChakraCheckbox.Indicator />}</ChakraCheckbox.Control>
      {children != null && <ChakraCheckbox.Label>{children}</ChakraCheckbox.Label>}
    </ChakraCheckbox.Root>
  )
);
Checkbox.displayName = "Checkbox";
