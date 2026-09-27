"use client";

import { useEffect } from "react";
import { installCorruptSessionRecovery } from "@/lib/corruptSessionRecovery";

/**
 * Mounts the global corrupt-session recovery listeners. Rendered once from the
 * root layout. Renders nothing; see `lib/corruptSessionRecovery.ts` for the
 * detection + clear-storage + reload logic. Installed from a client component
 * (rather than the client-instrumentation entry, whose module graph is fragile)
 * so it runs through the normal React/webpack module graph and reliably
 * registers on every hard navigation.
 */
export default function CorruptSessionRecovery() {
  useEffect(() => {
    return installCorruptSessionRecovery();
  }, []);
  return null;
}
