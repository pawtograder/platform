import { Alert, Stack } from "@pawtograder/webapp";

export const Statuses = () => (
  <Stack gap={3}>
    <Alert status="info" title="Autograder queued">
      Your submission is in the grading queue; results usually arrive within a minute.
    </Alert>
    <Alert status="success" title="All tests passed">
      24 of 24 hidden tests passed. Your grade has been recorded.
    </Alert>
    <Alert status="warning" title="Submitted after the deadline">
      A 10% late penalty was applied to this submission.
    </Alert>
    <Alert status="error" title="Build failed">
      The autograder could not compile your code. Check the build log for details.
    </Alert>
  </Stack>
);

export const Variants = () => (
  <Stack gap={3}>
    <Alert status="info" variant="subtle" title="Subtle">
      Regrade requests close 7 days after grades are released.
    </Alert>
    <Alert status="info" variant="solid" title="Solid">
      Office hours move to WVH 210 starting next week.
    </Alert>
    <Alert status="info" variant="surface" title="Surface">
      You are viewing a previous submission, not your latest.
    </Alert>
  </Stack>
);

export const TitleOnly = () => (
  <Alert status="success" title="Group membership confirmed — you are now in Team 7." />
);

export const Closable = () => (
  <Alert status="warning" closable title="Unsaved rubric changes">
    Apply or discard your changes before leaving this page.
  </Alert>
);
