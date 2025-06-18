import { Link as ChakraLink } from "@chakra-ui/react";
import NextLink from "next/link";

export default function Link({
  href,
  children,
  variant,
  colorPalette,
  prefetch,
  target,
  w
}: {
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
}) {
  return (
    <NextLink href={href} passHref legacyBehavior prefetch={prefetch === undefined ? null : prefetch}>
      <ChakraLink target={target} color={colorPalette} variant={variant} style={{ width: w }}>
        {children}
      </ChakraLink>
    </NextLink>
  );
}
