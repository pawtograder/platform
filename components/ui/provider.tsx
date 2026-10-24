"use client";

import { system } from "@/components/ui/theme";
import { createClient } from "@/utils/supabase/client";
import { ChakraProvider } from "@chakra-ui/react";

import { Refine } from "@refinedev/core";
import { liveProvider } from "@refinedev/supabase";
import { createDataProvider, retryUnlessMissingRow } from "@/lib/refineDataProvider";
import { ColorModeProvider, type ColorModeProviderProps } from "./color-mode";

const supabaseClient = createClient();
// Built once, outside the component, so a re-render doesn't hand <Refine> a
// freshly-allocated provider object on every pass.
const refineDataProvider = createDataProvider(supabaseClient);
export function Provider(props: ColorModeProviderProps) {
  // const notificationProvider = useNotificationProvider();
  return (
    <ChakraProvider value={system}>
      <Refine
        dataProvider={refineDataProvider}
        //notificationProvider={notificationProvider}
        options={{
          disableTelemetry: true,
          // Refine merges this into its own query defaults (refetchOnWindowFocus
          // off, keepPreviousData on).
          reactQuery: { clientConfig: { defaultOptions: { queries: { retry: retryUnlessMissingRow } } } }
        }}
        liveProvider={liveProvider(supabaseClient)}
      >
        <ColorModeProvider {...props} />
      </Refine>
    </ChakraProvider>
  );
}
