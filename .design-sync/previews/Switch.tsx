import { Switch, Stack, HStack, Text } from "@pawtograder/webapp";

export const Default = () => (
  <Switch defaultChecked>Publish assignment</Switch>
);

export const States = () => (
  <Stack gap={3} align="flex-start">
    <Switch defaultChecked>Enable autograder</Switch>
    <Switch>Allow group submissions</Switch>
    <Switch disabled>Email notifications (disabled)</Switch>
    <Switch defaultChecked disabled>
      Locked: anonymous grading
    </Switch>
  </Stack>
);

export const Colors = () => (
  <HStack gap={5} wrap="wrap">
    <Switch defaultChecked colorPalette="green">
      Grades visible
    </Switch>
    <Switch defaultChecked colorPalette="blue">
      Office hours open
    </Switch>
    <Switch defaultChecked colorPalette="orange">
      Late penalty active
    </Switch>
  </HStack>
);

export const SettingsRow = () => (
  <Stack gap={3} maxW="360px">
    <Text fontWeight="medium">Assignment 5 settings</Text>
    <HStack justify="space-between">
      <Text>Show autograder output to students</Text>
      <Switch defaultChecked colorPalette="green" />
    </HStack>
    <HStack justify="space-between">
      <Text>Accept submissions after due date</Text>
      <Switch colorPalette="green" />
    </HStack>
  </Stack>
);
