import { GradeAdjustments, Stack, Box, Text } from "@pawtograder/webapp";

export const Penalty = () => <GradeAdjustments tweak={-5} tweakNote="Late submission: 24h past the hard deadline." />;

export const Bonus = () => (
  <GradeAdjustments tweak={3} tweakNote="Extra credit for the optional concurrency stress test." />
);

export const NoNote = () => <GradeAdjustments tweak={-2} tweakNote={null} />;

export const ZeroRendersNothing = () => (
  <Box w="100%">
    <GradeAdjustments tweak={0} tweakNote="This should not appear." />
    <Stack gap={1}>
      <Text fontSize="sm" color="fg.muted">
        (Renders nothing when tweak is 0 — placeholder text shown for context.)
      </Text>
    </Stack>
  </Box>
);
