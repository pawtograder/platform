import { useState } from "react";
import { DebouncedInput, DebouncedTextarea, Field, Stack, Text } from "@pawtograder/webapp";

export const Input = () => {
  const [value, setValue] = useState("Correctness of insert/delete");
  return (
    <Stack gap={2} w="100%">
      <Field label="Criterion name">
        <DebouncedInput value={value} onCommit={setValue} placeholder="Name this criterion" />
      </Field>
      <Text fontSize="xs" color="fg.muted">
        Committed value: {value}
      </Text>
    </Stack>
  );
};

export const Textarea = () => {
  const [value, setValue] = useState(
    "Award full points if all hidden tests pass and the implementation is O(1) amortized."
  );
  return (
    <Stack gap={2} w="100%">
      <Field label="Check description">
        <DebouncedTextarea value={value} onCommit={setValue} rows={3} placeholder="Describe this check" />
      </Field>
      <Text fontSize="xs" color="fg.muted">
        Commits on blur or after a 500ms pause.
      </Text>
    </Stack>
  );
};
