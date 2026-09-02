import { DataListRoot, DataListItem, Box, Heading, Stack } from "@pawtograder/webapp";

export const SubmissionSummary = () => (
  <Box maxW="sm">
    <DataListRoot orientation="horizontal">
      <DataListItem label="Status" value="Graded" />
      <DataListItem label="Score" value="92 / 100" />
      <DataListItem label="Submitted" value="2 days ago" />
      <DataListItem label="Tests passed" value="24 / 24" />
      <DataListItem label="Late penalty" value="None" />
    </DataListRoot>
  </Box>
);

export const Vertical = () => (
  <Box maxW="sm">
    <DataListRoot orientation="vertical" gap={4}>
      <DataListItem label="Assignment" value="PS4: Binary Search Trees" />
      <DataListItem label="Repository" value="cs3100/ps4-jdoe" />
      <DataListItem label="Commit" value="a1b9f3c" />
      <DataListItem label="Autograder run" value="Completed in 47s" />
    </DataListRoot>
  </Box>
);

export const WithInfo = () => (
  <Box maxW="sm">
    <DataListRoot orientation="horizontal">
      <DataListItem
        label="Effective score"
        value="88 / 100"
        info="Includes a 10% late penalty applied automatically."
      />
      <DataListItem label="Hidden tests" value="18 / 20" info="Hidden tests are not visible until grades release." />
      <DataListItem label="Regrade window" value="Closes in 5 days" />
    </DataListRoot>
  </Box>
);

export const Sizes = () => (
  <Stack gap={6} maxW="sm">
    <Box>
      <Heading size="xs" mb={2}>
        Small
      </Heading>
      <DataListRoot size="sm" orientation="horizontal">
        <DataListItem label="Status" value="Active" />
        <DataListItem label="Members" value="3 of 4" />
      </DataListRoot>
    </Box>
    <Box>
      <Heading size="xs" mb={2}>
        Large
      </Heading>
      <DataListRoot size="lg" orientation="horizontal">
        <DataListItem label="Status" value="Active" />
        <DataListItem label="Members" value="3 of 4" />
      </DataListRoot>
    </Box>
  </Stack>
);
