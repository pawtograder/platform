"use client";

import { useColorMode } from "@/components/ui/color-mode";
import Image from "next/image";

export default function Logo({ width }: { width: number }) {
  const { colorMode } = useColorMode();
  return (
    <Image src={colorMode === "dark" ? "/Logo-Dark.png" : "/Logo-Light.png"} width={width} height={width} alt="Logo" />
  );
}
