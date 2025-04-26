"use client"

import { system } from "@/components/ui/theme";
import { createClient } from "@/utils/supabase/client";
import { ChakraProvider, createSystem, defaultConfig } from "@chakra-ui/react";

import { Refine } from "@refinedev/core";
import { dataProvider, liveProvider } from "@refinedev/supabase";
import {
  ColorModeProvider,
  ColorModeWatcher,
  type ColorModeProviderProps,
} from "./color-mode";

const supabaseClient = createClient();
export function Provider(props: ColorModeProviderProps) {
  // const notificationProvider = useNotificationProvider();
  return (
    <ChakraProvider value={system} >
      <Refine dataProvider={dataProvider(supabaseClient)}
        // notificationProvider={notificationProvider}
        options={{
          disableTelemetry: true
        }}
        liveProvider={liveProvider(supabaseClient)}
      >
        <ColorModeProvider {...props} />
      </Refine>
    </ChakraProvider>
  )
}
