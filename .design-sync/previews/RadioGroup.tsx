import { RadioGroup, Radio, Stack, Text } from "@pawtograder/webapp";

export const GradingScheme = () => (
  <RadioGroup defaultValue="letter">
    <Stack gap="3">
      <Text fontWeight="medium">Grading scheme</Text>
      <Radio value="letter">Letter grade (A–F)</Radio>
      <Radio value="points">Points out of 100</Radio>
      <Radio value="pass-fail">Pass / Fail</Radio>
    </Stack>
  </RadioGroup>
);

export const Horizontal = () => (
  <RadioGroup defaultValue="medium">
    <Stack direction="row" gap="6">
      <Radio value="low">Low priority</Radio>
      <Radio value="medium">Medium priority</Radio>
      <Radio value="high">High priority</Radio>
    </Stack>
  </RadioGroup>
);

export const WithDisabled = () => (
  <RadioGroup defaultValue="github">
    <Stack gap="3">
      <Radio value="github">Submit via GitHub repository</Radio>
      <Radio value="upload">Upload files directly</Radio>
      <Radio value="canvas" disabled>
        Import from Canvas (coming soon)
      </Radio>
    </Stack>
  </RadioGroup>
);

export const Colored = () => (
  <RadioGroup defaultValue="approve" colorPalette="green">
    <Stack gap="3">
      <Radio value="approve">Approve regrade request</Radio>
      <Radio value="deny">Deny regrade request</Radio>
      <Radio value="escalate">Escalate to instructor</Radio>
    </Stack>
  </RadioGroup>
);
