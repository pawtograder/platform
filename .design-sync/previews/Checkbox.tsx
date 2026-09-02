import { Checkbox, Stack, HStack, Text } from "@pawtograder/webapp";

export const Default = () => (
  <Checkbox defaultChecked>Release grades to students</Checkbox>
);

export const States = () => (
  <Stack gap={3} align="flex-start">
    <Checkbox defaultChecked>Allow late submissions</Checkbox>
    <Checkbox>Hide grades until released</Checkbox>
    <Checkbox disabled>Sync with GitHub Classroom (unavailable)</Checkbox>
    <Checkbox defaultChecked disabled>
      Locked: enforce due date
    </Checkbox>
  </Stack>
);

export const Colors = () => (
  <HStack gap={5} wrap="wrap">
    <Checkbox defaultChecked colorPalette="green">
      Passed all tests
    </Checkbox>
    <Checkbox defaultChecked colorPalette="blue">
      Reviewed
    </Checkbox>
    <Checkbox defaultChecked colorPalette="red">
      Flagged for plagiarism
    </Checkbox>
  </HStack>
);

export const ChecklistGroup = () => (
  <Stack gap={2} maxW="340px">
    <Text fontWeight="medium">Rubric checks for Submission #4821</Text>
    <Checkbox defaultChecked colorPalette="green">
      Compiles without warnings
    </Checkbox>
    <Checkbox defaultChecked colorPalette="green">
      Passes unit tests (24/24)
    </Checkbox>
    <Checkbox colorPalette="green">Includes README documentation</Checkbox>
    <Checkbox colorPalette="green">Follows style guide</Checkbox>
  </Stack>
);
