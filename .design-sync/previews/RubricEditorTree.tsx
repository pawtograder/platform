import { Box } from "@pawtograder/webapp";
import { RubricEditorTree } from "@pawtograder/webapp";
import { rubricFixture } from "./_rubricFixture";

export const FullTree = () => (
  <Box maxW="900px">
    <RubricEditorTree
      rubric={rubricFixture}
      onChange={() => {}}
      validationErrors={[]}
      assignmentMaxPoints={100}
      autograderPoints={40}
    />
  </Box>
);
