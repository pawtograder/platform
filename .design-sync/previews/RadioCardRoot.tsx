import { RadioCardRoot, RadioCardItem, RadioCardLabel, SimpleGrid, Stack } from "@pawtograder/webapp";

export const SubmissionMethod = () => (
  <RadioCardRoot defaultValue="github" maxW="md">
    <RadioCardLabel>How will students submit?</RadioCardLabel>
    <Stack gap="3" mt="2">
      <RadioCardItem
        value="github"
        label="GitHub repository"
        description="Students push commits to an autograded repo."
      />
      <RadioCardItem
        value="upload"
        label="File upload"
        description="Students upload a zip or individual files."
      />
    </Stack>
  </RadioCardRoot>
);

export const GraderGrid = () => (
  <RadioCardRoot defaultValue="auto" colorPalette="green">
    <RadioCardLabel>Grading mode</RadioCardLabel>
    <SimpleGrid columns={3} gap="3" mt="2">
      <RadioCardItem value="auto" label="Autograder" description="Run hidden test suite" />
      <RadioCardItem value="manual" label="Manual" description="TA rubric review" />
      <RadioCardItem value="hybrid" label="Hybrid" description="Tests + rubric" />
    </SimpleGrid>
  </RadioCardRoot>
);

export const WithDisabled = () => (
  <RadioCardRoot defaultValue="standard" maxW="md">
    <RadioCardLabel>Late policy</RadioCardLabel>
    <Stack gap="3" mt="2">
      <RadioCardItem value="standard" label="Standard" description="10% penalty per day late." />
      <RadioCardItem value="tokens" label="Late tokens" description="Spend a token to waive penalty." />
      <RadioCardItem value="none" label="No late work" description="Locked after the term starts." disabled />
    </Stack>
  </RadioCardRoot>
);
