import type { Meta, StoryObj } from "@storybook/react";
import { RubricSidebar } from "./rubric-sidebar";
import { AssignmentProvider } from "../../.storybook/mocks/hooks/useAssignment";
import { SubmissionReviewProvider } from "../../.storybook/mocks/hooks/useSubmissionReview";
import { Box } from "@chakra-ui/react";

const meta: Meta<typeof RubricSidebar> = {
  title: "Grading/RubricSidebar",
  component: RubricSidebar,
  decorators: [
    (Story) => (
      <AssignmentProvider>
        <SubmissionReviewProvider>
          <Box maxW="28rem" p={2}>
            <Story />
          </Box>
        </SubmissionReviewProvider>
      </AssignmentProvider>
    )
  ]
};

export default meta;
type Story = StoryObj<typeof RubricSidebar>;

export const Default: Story = {
  args: { rubricId: 1 }
};
