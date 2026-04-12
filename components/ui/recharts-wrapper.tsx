"use client";
import dynamic from "next/dynamic";
import { Spinner } from "@chakra-ui/react";
import React from "react";
import type { ComponentProps } from "react";

// Re-export child components directly from recharts
// These don't need dynamic loading - only the container components do
export { Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";

type BarChartProps = ComponentProps<typeof import("recharts").BarChart>;
type ResponsiveContainerProps = ComponentProps<typeof import("recharts").ResponsiveContainer>;

// Only dynamically load the container components to reduce initial bundle size
// The child components are re-exported directly above
export const BarChart = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.BarChart as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false, loading: () => <Spinner /> }
) as React.ComponentType<BarChartProps>;

export const ResponsiveContainer = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.ResponsiveContainer as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false, loading: () => <Spinner /> }
) as React.ComponentType<ResponsiveContainerProps>;
