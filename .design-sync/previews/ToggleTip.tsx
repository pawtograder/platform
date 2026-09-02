import { ToggleTip, InfoTip, Button, IconButton, Text, Stack, HStack } from "@pawtograder/webapp";
import { LuSettings } from "react-icons/lu";

export const CurveToggleTip = () => (
  <HStack>
    <Text fontSize="sm">Final grade curve</Text>
    <ToggleTip
      open
      showArrow
      portalled={false}
      content={
        <Stack gap={1} maxW="220px" p={1}>
          <Text fontWeight="medium" fontSize="xs">
            How the curve works
          </Text>
          <Text fontSize="xs" color="fg.muted">
            Scores are scaled so the class median maps to a B. Raw scores are never lowered.
          </Text>
        </Stack>
      }
    >
      <IconButton aria-label="Curve settings" variant="ghost" size="xs">
        <LuSettings />
      </IconButton>
    </ToggleTip>
  </HStack>
);

export const LatePolicyInfoTip = () => (
  <HStack>
    <Text fontSize="sm">Late submission policy</Text>
    <InfoTip open showArrow portalled={false}>
      <Text fontSize="xs" maxW="200px">
        10% deducted per day late, up to 3 days. After that the autograder will not run.
      </Text>
    </InfoTip>
  </HStack>
);

export const CoverageInfoTip = () => (
  <HStack>
    <Text fontSize="sm">Coverage threshold</Text>
    <InfoTip open showArrow portalled={false}>
      <Text fontSize="xs" maxW="200px">
        Full points require at least 85% line coverage across all test files.
      </Text>
    </InfoTip>
  </HStack>
);
