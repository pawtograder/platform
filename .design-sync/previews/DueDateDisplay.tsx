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

// `suggested-due-date` course flag ON: the suggested date IS the due date, and the hard deadline
// becomes the close of the resubmission window. Both dates go in as plain nodes — the emphasis
// hierarchy is the whole point of this card, and a bare `suggestedDueDate` would render through
// TimeZoneAwareDate and capture blank (see the harness note at the top of this file).
export const SuggestedDateShown = () => (
  <Box maxW="420px">
    <DueDateDisplay
      showDueLabel
      showSuggested
      suggestedDueDate="2026-03-18T23:59:00-04:00"
      suggestedDueDateNode={<Text>Mar 18, 11:59 PM</Text>}
      dueDate="2026-04-15T23:59:00-04:00"
      dueDateNode={<Text>Apr 15, 11:59 PM</Text>}
    />
  </Box>
);
