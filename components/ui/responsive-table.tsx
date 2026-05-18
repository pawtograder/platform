"use client";

import { Box, Table, type BoxProps, type TableRootProps } from "@chakra-ui/react";
import * as React from "react";

type ResponsiveTableProps = {
  /** Minimum width the inner `<table>` is allowed to shrink to before the
   * outer Box becomes horizontally scrollable. Defaults to `auto` (no
   * forcing), which is what most lists want. */
  tableMinW?: TableRootProps["minW"];
  /** Inner `<Table.Root>` props pass-through. */
  rootProps?: Omit<TableRootProps, "minW">;
  /** Outer scroll-wrapper props pass-through. */
  wrapperProps?: BoxProps;
  children: React.ReactNode;
};

/**
 * Tables wrapped in this scroll horizontally inside their own viewport at
 * narrow widths / high zoom, instead of pushing the whole page horizontal
 * (WCAG 1.4.10).
 */
export function ResponsiveTable({ tableMinW = "auto", rootProps, wrapperProps, children }: ResponsiveTableProps) {
  return (
    <Box overflowX="auto" w="100%" mx={0} {...wrapperProps}>
      <Table.Root w="100%" minW={tableMinW} {...rootProps}>
        {children}
      </Table.Root>
    </Box>
  );
}
