"use client";

import { Container, type ContainerProps } from "@chakra-ui/react";
import * as React from "react";

/**
 * Standard page-level container for student-facing routes. Uses
 * `Container.maxW="container.xl"` and a responsive horizontal padding that
 * collapses on narrow viewports / high zoom (WCAG 1.4.10 reflow).
 *
 * Routes wrap their top-level content in this so we have a single place to
 * tune side gutters and overall width.
 */
export function PageContainer({ children, maxW = "container.xl", ...rest }: ContainerProps) {
  return (
    <Container w="100%" maxW={maxW} px={{ base: 3, md: 6 }} py={{ base: 3, md: 4 }} {...rest}>
      {children}
    </Container>
  );
}
