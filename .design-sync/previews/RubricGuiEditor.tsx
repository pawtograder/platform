import { Box } from "@pawtograder/webapp";
import { RubricGuiEditor } from "@pawtograder/webapp";
import { rubricFixture } from "./_rubricFixture";

export const FullRubric = () => (
  <Box maxW="900px">
    <RubricGuiEditor
      rubric={rubricFixture}
      onCommit={() => {}}
      assignmentMaxPoints={100}
      autograderPoints={40}
    />
  </Box>
);
