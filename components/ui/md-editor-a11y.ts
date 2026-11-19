import type { ICommand } from "@uiw/react-md-editor";
import { cloneElement, isValidElement, type ReactElement, type SVGProps } from "react";

/**
 * `commandsFilter` for `@uiw/react-md-editor`. Toolbar buttons already have names, so their icons
 * are decorative; without aria-hidden each is an unnamed <svg role="img"> (#908).
 */
export function hideToolbarIcon(command: ICommand): ICommand {
  if (!isValidElement(command.icon)) return command;
  return {
    ...command,
    icon: cloneElement(command.icon as ReactElement<SVGProps<SVGSVGElement>>, { "aria-hidden": true })
  };
}
