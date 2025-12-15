"use client";
import dynamic from "next/dynamic";
import { Spinner } from "@chakra-ui/react";
import React from "react";
import type { ComponentProps } from "react";

// Dynamic import of Recharts to reduce build memory usage
// Create wrapper components that properly handle dynamic imports
// Using type assertions to work around TypeScript strict typing with class components

type BarChartProps = ComponentProps<typeof import("recharts").BarChart>;
type BarProps = ComponentProps<typeof import("recharts").Bar>;
type XAxisProps = ComponentProps<typeof import("recharts").XAxis>;
type YAxisProps = ComponentProps<typeof import("recharts").YAxis>;
type CartesianGridProps = ComponentProps<typeof import("recharts").CartesianGrid>;
type TooltipProps = ComponentProps<typeof import("recharts").Tooltip>;
type LegendProps = ComponentProps<typeof import("recharts").Legend>;
type ResponsiveContainerProps = ComponentProps<typeof import("recharts").ResponsiveContainer>;

// Create wrapper components that load recharts on mount
// Using React.createElement with type assertions to bypass TypeScript strict typing
// The runtime behavior is correct, but TypeScript has issues with class component defaultProps types
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

export const Bar = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.Bar as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false }
) as React.ComponentType<BarProps>;

export const XAxis = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.XAxis as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false }
) as React.ComponentType<XAxisProps>;

export const YAxis = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.YAxis as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false }
) as React.ComponentType<YAxisProps>;

export const CartesianGrid = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.CartesianGrid as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false }
) as React.ComponentType<CartesianGridProps>;

export const Tooltip = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.Tooltip as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false }
) as React.ComponentType<TooltipProps>;

export const Legend = dynamic(
  () =>
    import("recharts").then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Wrapper = (props: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return React.createElement(mod.Legend as any, props);
      };
      return { default: Wrapper };
    }),
  { ssr: false }
) as React.ComponentType<LegendProps>;

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
