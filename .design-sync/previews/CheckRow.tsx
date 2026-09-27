import { Box, Stack, Text } from "@pawtograder/webapp";
import { CheckRow } from "@pawtograder/webapp";
import { checkFixture, annotationCheckFixture } from "./_rubricFixture";

export const ScoringCheck = () => (
  <Box maxW="780px">
    <CheckRow
      check={checkFixture}
      onChange={() => {}}
      onDelete={() => {}}
      validationErrors={[]}
      pathPrefix="parts.0.criteria.0.checks.0"
      currentRubricReviewRound="grading-review"
    />
  </Box>
);

export const AnnotationCheck = () => (
  <Box maxW="780px">
    <CheckRow
      check={annotationCheckFixture}
      onChange={() => {}}
      onDelete={() => {}}
      validationErrors={[]}
      pathPrefix="parts.1.criteria.0.checks.0"
      currentRubricReviewRound="grading-review"
    />
  </Box>
);
