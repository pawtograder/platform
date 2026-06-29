import { DownloadLink, Stack, HStack } from "@pawtograder/webapp";
import { LuDownload } from "react-icons/lu";

export const Default = () => (
  <DownloadLink
    href="https://storage.pawtograder.com/submissions/team-7/assignment-4.zip"
    filename="assignment-4-submission.zip"
  />
);

export const CustomLabel = () => (
  <DownloadLink
    href="https://storage.pawtograder.com/exports/cs3100-grades.csv"
    filename="cs3100-grades.csv"
    color="blue.fg"
  >
    <HStack gap={1}>
      <LuDownload />
      Export gradebook (CSV)
    </HStack>
  </DownloadLink>
);

export const List = () => (
  <Stack gap={2}>
    <DownloadLink href="https://storage.pawtograder.com/handouts/a4-spec.pdf" filename="a4-spec.pdf" />
    <DownloadLink href="https://storage.pawtograder.com/handouts/starter-code.zip" filename="starter-code.zip" />
    <DownloadLink href="https://storage.pawtograder.com/handouts/rubric.pdf" filename="a4-rubric.pdf" />
  </Stack>
);
