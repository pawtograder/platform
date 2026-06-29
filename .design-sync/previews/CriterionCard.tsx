import { Box } from "@pawtograder/webapp";
import { CriterionCard } from "@pawtograder/webapp";
import { criteriaFixture } from "./_rubricFixture";

export const Default = () => (
  <Box maxW="820px">
    <CriterionCard
      criteria={criteriaFixture}
      onChange={() => {}}
      onDelete={() => {}}
      validationErrors={[]}
      pathPrefix="parts.0.criteria.0"
      currentRubricReviewRound="grading-review"
    />
  </Box>
);
