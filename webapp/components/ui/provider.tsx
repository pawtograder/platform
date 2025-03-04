"use client"

import { createClient } from "@/utils/supabase/client";
import { ChakraProvider, defaultConfig, createSystem, defaultSystem, defineConfig } from "@chakra-ui/react";
import {
  useNotificationProvider
} from "@refinedev/chakra-ui";
import { Refine } from "@refinedev/core";
import { dataProvider, liveProvider } from "@refinedev/supabase";
import {
  ColorModeProvider,
  type ColorModeProviderProps,
} from "./color-mode";
import { theme } from '@chakra-ui/pro-theme'

// const customConfig = defineConfig({
//   theme: {
//     semanticTokens: {
//       colors: {
//         bg: {
//           subtle: { value: "#F6F8FA" },
//         },
//       },
//     },
//     tokens: {
//       colors: {
//         brand: {
//           50: { value: "#e6f2ff" },
//           100: { value: "#e6f2ff" },
//           200: { value: "#bfdeff" },
//           300: { value: "#99caff" },
//           // ...
//           950: { value: "#001a33" },
//         },
//       },
//     },
//   },
// })

// const system = createSystem(defaultConfig, customConfig)
const system = createSystem(defaultConfig)


const supabaseClient = createClient();
export function Provider(props: ColorModeProviderProps) {
  // const notificationProvider = useNotificationProvider();
  return (
    <ChakraProvider value={system} >
      <Refine dataProvider={dataProvider(supabaseClient)}
        // notificationProvider={notificationProvider}
        liveProvider={liveProvider(supabaseClient)}
        options={{ liveMode: "auto" }}>
        <ColorModeProvider {...props} />
      </Refine>
    </ChakraProvider>
  )
}
