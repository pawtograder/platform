"use client";

import { useEffect } from "react";
import { installStaleBundleRecovery } from "@/lib/staleBundleRecovery";

/**
 * Mounts the global stale-bundle (deploy-skew) recovery listeners. Rendered once
 * from the root layout. Renders nothing; see `lib/staleBundleRecovery.ts` for the
 * detection + reload logic. Installed from a client component (rather than the
 * client-instrumentation entry) so it runs through the normal React/webpack
 * module graph and reliably registers on every hard navigation.
 */
export default function StaleBundleRecovery() {
  useEffect(() => {
    return installStaleBundleRecovery();
  }, []);
  return null;
}
