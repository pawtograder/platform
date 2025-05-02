"use client"

import { system } from "@/components/ui/theme";
import { createClient } from "@/utils/supabase/client";
import { ChakraProvider, createSystem, defaultConfig } from "@chakra-ui/react";

import { Refine, useResource } from "@refinedev/core";
import { dataProvider, liveProvider } from "@refinedev/supabase";
import {
  ColorModeProvider,
  type ColorModeProviderProps,
} from "./color-mode";

const supabaseClient = createClient();
export function Provider(props: ColorModeProviderProps) {
  const {resources} = useResource();
  // const notificationProvider = useNotificationProvider();
  return (
    <ChakraProvider value={system} >
      <Refine dataProvider={dataProvider(supabaseClient)}
      resources={resources.map((resource) => ({name:resource.name}))}
        //notificationProvider={notificationProvider}
        options={{
          disableTelemetry: true,
          liveMode: "auto"
        }}
        liveProvider={liveProvider(supabaseClient)}
      >
        <ColorModeProvider {...props} />
      </Refine>
    </ChakraProvider>
  )
}
