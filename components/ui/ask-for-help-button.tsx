"use client";
import { Button, Icon } from "@chakra-ui/react";
import { useFeatureEnabled } from "@/hooks/useCourseFeatures";
import { useHelpDrawer } from "@/hooks/useHelpDrawer";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { FaQuestionCircle } from "react-icons/fa";
export default function AskForHelpButton() {
  const featureEnabled = useFeatureEnabled(COURSE_FEATURES.OFFICE_HOURS);
  // Opens the same drawer as the floating help widget and the office-hours status card.
  // HelpDrawerProvider wraps every course page (app/course/[course_id]/layout.tsx), which
  // is the only place this button renders, so the hook always finds its context. Called
  // before the feature-flag early return to keep hook order stable across renders.
  const { openDrawer } = useHelpDrawer();
  if (!featureEnabled) {
    return null;
  }
  return (
    <Button variant="surface" onClick={openDrawer}>
      <Icon as={FaQuestionCircle} />
      Ask For Help
    </Button>
  );
}
