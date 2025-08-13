import type { Preview } from "@storybook/react";
import { ChakraProvider, extendTheme } from "@chakra-ui/react";
import React from "react";

const theme = extendTheme({});

const preview: Preview = {
  decorators: [
    (Story) => (
      <ChakraProvider theme={theme}>
        <div style={{ padding: 16 }}>
          <Story />
        </div>
      </ChakraProvider>
    )
  ]
};

export default preview;