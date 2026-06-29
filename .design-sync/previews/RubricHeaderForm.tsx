import { Box } from "@pawtograder/webapp";
import { RubricHeaderForm } from "@pawtograder/webapp";
import { rubricFixture } from "./_rubricFixture";

export const Default = () => (
  <Box maxW="760px">
    <RubricHeaderForm rubric={rubricFixture} onChange={() => {}} validationErrors={[]} />
  </Box>
);
