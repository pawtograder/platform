import { Link as ChakraLink } from "@chakra-ui/react";
import NextLink from "next/link";
import { forwardRef } from "react";

type LinkProps = {
  href: string;
  children: React.ReactNode;
  variant?: "underline" | "plain";
  colorPalette?:
    | "gray"
    | "blue"
    | "red"
    | "green"
    | "yellow"
    | "purple"
    | "orange"
    | "pink"
    | "teal"
    | "cyan"
    | "black"
    | "white"
    | "accent";
  prefetch?: null | true | false;
  target?: "_blank" | "_self";
  w?: string;
} & React.ComponentProps<typeof ChakraLink>;

/** Wraps NextLink + ChakraLink, forwarding its ref to the rendered anchor.
 *
 *  The ref matters for composition: Chakra's `asChild` (as in `<Button asChild>`)
 *  clones its child, and needs the ref as well as the props to reach the anchor.
 *  Without forwardRef the ref is dropped silently — the link still renders, but
 *  anything Chakra drives through it (focus management, measurement) is lost.
 *
 *  Every `<Button asChild>` in the app today passes `next/link` directly, so
 *  nothing depends on this; it exists so that using this wrapper there cannot
 *  quietly misbehave. Raised in review on PR #862.
 */
const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, children, variant, colorPalette, prefetch, target, w, ...rest },
  ref
) {
  return (
    <NextLink href={href} passHref legacyBehavior prefetch={prefetch === undefined ? null : prefetch}>
      <ChakraLink ref={ref} target={target} color={colorPalette} variant={variant} style={{ width: w }} {...rest}>
        {children}
      </ChakraLink>
    </NextLink>
  );
});

export default Link;
