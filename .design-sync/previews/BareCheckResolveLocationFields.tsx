import { useState } from "react";
import { Box, Text, VStack } from "@pawtograder/webapp";
import { BareCheckResolveLocationFields } from "@pawtograder/webapp";

// Minimal RubricCheck fixtures. Only the fields the component reads
// (is_annotation, annotation_target, file, artifact) drive behavior.
const fileCheck = {
  id: 4201,
  name: "Missing null check on tree root",
  is_annotation: true,
  annotation_target: "file",
  file: "src/main/java/bst/BinarySearchTree.java",
  artifact: null,
  points: 5
} as unknown as Parameters<typeof BareCheckResolveLocationFields>[0]["rubricCheck"];

const artifactCheck = {
  id: 4202,
  name: "Coverage report below threshold",
  is_annotation: true,
  annotation_target: "artifact",
  file: null,
  artifact: null,
  points: 3
} as unknown as Parameters<typeof BareCheckResolveLocationFields>[0]["rubricCheck"];

const submissionFiles = [
  { id: 91, name: "src/main/java/bst/BinarySearchTree.java" },
  { id: 92, name: "src/main/java/bst/Node.java" },
  { id: 93, name: "src/test/java/bst/BstTest.java" }
];

const submissionArtifacts = [
  { id: 71, name: "jacoco-coverage.html" },
  { id: 72, name: "checkstyle-report.xml" }
];

export const FileLocation = () => {
  const [location, setLocation] = useState({
    submissionFileId: 91,
    line: 42
  });
  return (
    <Box maxW="460px" p={4}>
      <Text fontSize="sm" fontWeight="semibold" mb={3}>
        Resolve: line annotation check
      </Text>
      <BareCheckResolveLocationFields
        rubricCheck={fileCheck}
        submissionFiles={submissionFiles}
        submissionArtifacts={submissionArtifacts}
        location={location}
        onChange={setLocation}
        idPrefix="preview-file"
      />
    </Box>
  );
};

export const ArtifactLocation = () => {
  const [location, setLocation] = useState({ submissionArtifactId: 71 });
  return (
    <Box maxW="460px" p={4}>
      <Text fontSize="sm" fontWeight="semibold" mb={3}>
        Resolve: artifact check
      </Text>
      <VStack align="stretch" gap={0}>
        <BareCheckResolveLocationFields
          rubricCheck={artifactCheck}
          submissionFiles={submissionFiles}
          submissionArtifacts={submissionArtifacts}
          location={location}
          onChange={setLocation}
          idPrefix="preview-artifact"
        />
      </VStack>
    </Box>
  );
};
