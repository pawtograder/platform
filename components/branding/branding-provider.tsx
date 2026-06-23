"use client";

import { createContext, useContext } from "react";
import { DEFAULT_BRANDING, type Branding } from "@/lib/branding";

const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

/**
 * Makes the deployment branding (resolved server-side via `getBranding()` and
 * passed down from the root layout) available to client components through
 * `useBranding()`. Defaults to the built-in Pawtograder branding if no provider
 * is mounted (e.g. in isolated component tests).
 */
export function BrandingProvider({ branding, children }: { branding: Branding; children: React.ReactNode }) {
  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

/** Read the active deployment branding from any client component. */
export function useBranding(): Branding {
  return useContext(BrandingContext);
}
