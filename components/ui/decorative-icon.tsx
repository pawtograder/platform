"use client";

import { Icon, type IconProps } from "@chakra-ui/react";
import * as React from "react";

type DecorativeIconProps = Omit<IconProps, "aria-hidden" | "focusable"> & {
  as: React.ElementType;
};

/**
 * Use for icon glyphs that sit inside a control whose accessible name is
 * already supplied elsewhere (IconButton with aria-label, Button with
 * visible text, Menu.Item with text, Link with text). Forces
 * `aria-hidden="true"` and `focusable={false}` so screen readers don't
 * announce the icon twice or get confused by an inner title element.
 *
 * For icons that *are* the accessible name (rare — almost always wrong),
 * use a labeled `<Icon>` or `<IconButton>` instead.
 */
export function DecorativeIcon(props: DecorativeIconProps) {
  return <Icon aria-hidden focusable={false} {...props} />;
}
