// Lightweight provider for design-sync previews.
// The app's real components/ui/provider.tsx wraps ChakraProvider in Refine +
// Supabase, which previews can't (and shouldn't) load. This provides just the
// Chakra v3 system so theme tokens/fonts are applied at runtime.
import { ChakraProvider } from "@chakra-ui/react";
import * as React from "react";
import { system } from "@/components/ui/theme";

export function PreviewProvider({ children }: { children?: React.ReactNode }) {
  return <ChakraProvider value={system}>{children}</ChakraProvider>;
}
