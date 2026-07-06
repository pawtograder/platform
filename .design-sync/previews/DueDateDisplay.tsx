import { Box, Text, Badge } from "@pawtograder/webapp";
import { DueDateDisplay } from "@pawtograder/webapp";

// NOTE: the component renders live dates via TimeZoneAwareDate, whose output the
// capture harness redacts (data-visual-test="transparent"). Previews pass a plain
// `dueDateNode` instead of `dueDate` so the deadline renders as stable, visible text.

export const HardDeadline = () => (
  <Box maxW="420px">
    <DueDateDisplay showDueLabel dueDateNode={<Text>Mar 18, 11:59 PM</Text>} />
  </Box>
);

export const WithExtension = () => (
  <Box maxW="420px">
    <DueDateDisplay
      showDueLabel
      dueDateNode={<Text>Mar 18, 11:59 PM</Text>}
      trailing={<Badge colorPalette="green">+2 day extension</Badge>}
    />
  </Box>
);

export const LateTokenAvailable = () => (
  <Box maxW="420px">
    <DueDateDisplay
      dueDateNode={<Text>Mar 18, 11:59 PM</Text>}
      trailing={<Badge colorPalette="orange">1 late token left</Badge>}
    />
  </Box>
);

export const NoDate = () => (
  <Box maxW="420px">
    <DueDateDisplay />
  </Box>
);
