"use client";

import { useEffect, useState } from "react";

/** Throws on the render after mount, so the crash happens client-side after hydration. */
export default function RenderCrash() {
  const [crash, setCrash] = useState(false);
  useEffect(() => setCrash(true), []);
  if (crash) {
    throw new Error("E2E forced render crash");
  }
  return <main id="main-content">About to crash</main>;
}
