import { notFound } from "next/navigation";
import RenderCrash from "./RenderCrash";

// Read E2E_ENABLE per request, never at build time.
export const dynamic = "force-dynamic";

/**
 * E2E-only page that crashes during a client render, so tests can reach
 * `app/global-error.tsx` (test E9). It 404s unless the server runs with `E2E_ENABLE=true`,
 * which the Helm chart refuses for production installs (`charts/pawtograder/templates/validations.yaml`).
 */
export default function RenderCrashPage() {
  if (process.env.E2E_ENABLE !== "true") {
    notFound();
  }
  return <RenderCrash />;
}
