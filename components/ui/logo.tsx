"use client";

import { useColorMode } from "@/components/ui/color-mode";

export default function Logo({ width }: { width: number }) {
  const { colorMode } = useColorMode();
  return <img src={colorMode === "dark" ? "/Logo-Dark.png" : "/Logo-Light.png"} width={width} alt="Logo" />;
}
