"use client";

import { wrapLabel } from "./utils";

const LINE_HEIGHT = 12;
const FONT_SIZE = 10;

type WrappedYAxisTickProps = {
  x?: number;
  y?: number;
  payload?: { value: string };
  width?: number;
  fill?: string;
  /** Optional suffix to append (e.g. survey label) */
  suffix?: string;
};

/** Custom Y-axis tick that wraps long labels onto multiple lines */
export function WrappedYAxisTick({
  x = 0,
  y = 0,
  payload,
  width = 380,
  fill = "currentColor",
  suffix
}: WrappedYAxisTickProps) {
  const raw = payload?.value ?? "";
  const text = suffix ? `${raw} (${suffix})` : raw;
  const charsPerLine = Math.max(20, Math.floor(width / 8));
  const lines = wrapLabel(text, charsPerLine);
  const totalHeight = lines.length * LINE_HEIGHT;
  const startY = -totalHeight / 2 + LINE_HEIGHT / 2;

  return (
    <g transform={`translate(${x}, ${y})`}>
      {lines.map((line, i) => (
        <text key={i} x={0} y={startY + i * LINE_HEIGHT} textAnchor="end" fontSize={FONT_SIZE} fill={fill}>
          {line}
        </text>
      ))}
    </g>
  );
}
