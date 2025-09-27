import React from "react";
import type { Preview } from "@storybook/react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@/components/ui/theme";
import { ColorModeProvider } from "@/components/ui/color-mode";
import "../app/globals.css";

const preview: Preview = {
  decorators: [
    (Story) => (
      <ChakraProvider value={system}>
        <ColorModeProvider>
          <Story />
        </ColorModeProvider>
      </ChakraProvider>
    )
  ]
};

export default preview;
