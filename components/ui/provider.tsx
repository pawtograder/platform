"use client";

import { useState } from "react";
import { system } from "@/components/ui/theme";
import { createClient } from "@/utils/supabase/client";
import { ChakraProvider } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { LeaderProvider } from "@/lib/cross-tab/LeaderProvider";

import { Refine } from "@refinedev/core";
import { dataProvider, liveProvider } from "@refinedev/supabase";
import { ColorModeProvider, type ColorModeProviderProps } from "./color-mode";

const supabaseClient = createClient();
export function Provider(props: ColorModeProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000, // 30 seconds - RT updates handle freshness
            refetchOnWindowFocus: false // leader handles reconnection
          }
        }
      })
  );

  // const notificationProvider = useNotificationProvider();
  return (
    <ChakraProvider value={system}>
      <QueryClientProvider client={queryClient}>
        <LeaderProvider>
          <Refine
            dataProvider={dataProvider(supabaseClient)}
            //notificationProvider={notificationProvider}
            options={{ disableTelemetry: true }}
            liveProvider={liveProvider(supabaseClient)}
          >
            <ColorModeProvider {...props} />
          </Refine>
          <ReactQueryDevtools initialIsOpen={false} />
        </LeaderProvider>
      </QueryClientProvider>
    </ChakraProvider>
  );
}
