import { Box } from "@pawtograder/webapp";
import { PartCard } from "@pawtograder/webapp";
import { partFixture } from "./_rubricFixture";

export const Default = () => (
  <Box maxW="860px">
    <PartCard
      part={partFixture}
      displayIndex={0}
      onChange={() => {}}
      onDelete={() => {}}
      validationErrors={[]}
      pathPrefix="parts.0"
      currentRubricReviewRound="grading-review"
    />
  </Box>
);
