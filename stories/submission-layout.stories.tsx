import type { Meta, StoryObj } from "@storybook/react";
import SubmissionsLayoutWrapper from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/layout";
import FilesView from "@/app/course/[course_id]/assignments/[assignment_id]/submissions/[submissions_id]/files/page";
import { AssignmentProvider } from "../.storybook/mocks/hooks/useAssignment";
import { SubmissionProvider } from "../.storybook/mocks/hooks/useSubmission";
import { SubmissionReviewProvider } from "../.storybook/mocks/hooks/useSubmissionReview";
import { Box } from "@chakra-ui/react";

const meta: Meta = {
  title: "Grading/SubmissionLayout",
  decorators: [
    (Story) => (
      <AssignmentProvider>
        <SubmissionProvider>
          <SubmissionReviewProvider>
            <Box h="90vh" p={2}>
              <Story />
            </Box>
          </SubmissionReviewProvider>
        </SubmissionProvider>
      </AssignmentProvider>
    )
  ]
};

export default meta;
type Story = StoryObj;

export const FullLayout: Story = {
  render: () => (
    <SubmissionsLayoutWrapper>
      <FilesView />
    </SubmissionsLayoutWrapper>
  )
};
