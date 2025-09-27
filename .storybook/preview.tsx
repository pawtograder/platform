import React from "react";
import type { Preview } from "@storybook/react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@/components/ui/theme";
import { ColorModeProvider } from "@/components/ui/color-mode";
import { AssignmentProvider } from "./mocks/hooks/useAssignment";
import { SubmissionProvider } from "./mocks/hooks/useSubmission";
import { SubmissionReviewProvider } from "./mocks/hooks/useSubmissionReview";
import "../app/globals.css";

const preview: Preview = {
  decorators: [
    (Story) => (
      <ChakraProvider value={system}>
        <ColorModeProvider>
          <AssignmentProvider>
            <SubmissionProvider>
              <SubmissionReviewProvider>
                <Story />
              </SubmissionReviewProvider>
            </SubmissionProvider>
          </AssignmentProvider>
        </ColorModeProvider>
      </ChakraProvider>
    )
  ]
};

export default preview;
