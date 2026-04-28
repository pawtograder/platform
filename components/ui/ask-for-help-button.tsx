"use client";
import { Button, Icon } from "@chakra-ui/react";
import { useFeatureEnabled } from "@/hooks/useClassProfiles";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { FaQuestionCircle } from "react-icons/fa";
export default function AskForHelpButton() {
  const featureEnabled = useFeatureEnabled(COURSE_FEATURES.OFFICE_HOURS);
  if (!featureEnabled) {
    return null;
  }
  return (
    <Button
      variant="surface"
      onClick={() => {
        // toaster({
        //     title: "Ask For Help",
        //     description: "This feature is not yet implemented.",
        //     status: "info"
        // });
      }}
    >
      <Icon as={FaQuestionCircle} />
      Ask For Help
    </Button>
  );
}
