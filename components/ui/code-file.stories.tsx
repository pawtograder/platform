import type { Meta, StoryObj } from "@storybook/react";
import CodeFile from "./code-file";
import { SubmissionProvider } from "../../.storybook/mocks/hooks/useSubmission";
import { SubmissionReviewProvider } from "../../.storybook/mocks/hooks/useSubmissionReview";
import { Box } from "@chakra-ui/react";

const meta: Meta<typeof CodeFile> = {
  title: "Grading/CodeFile",
  component: CodeFile,
  decorators: [
    (Story) => (
      <SubmissionProvider>
        <SubmissionReviewProvider>
          <Box maxW="900px" p={2}>
            <Story />
          </Box>
        </SubmissionReviewProvider>
      </SubmissionProvider>
    )
  ]
};

export default meta;
type Story = StoryObj<typeof CodeFile>;

export const JavaFile: Story = {
  args: {
    file: { id: 11, class_id: 1, submission_id: 1, name: "Main.java", contents: "public class Main { }" } as any
  }
};
