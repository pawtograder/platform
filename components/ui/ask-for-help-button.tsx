"use client";
import { Button, Icon } from "@chakra-ui/react";
import { FaQuestionCircle } from "react-icons/fa";
import { useFeatureEnabled } from "@/hooks/useClassProfiles";
export default function AskForHelpButton() {
  const featureEnabled = useFeatureEnabled("office-hours");
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
