"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Box, Spinner } from "@chakra-ui/react";
import { toaster } from "@/components/ui/toaster";
import { useCapabilityOnceLoaded } from "@/hooks/useClassProfiles";
import HelpRequestTemplateManagement from "../../helpRequestTemplateManagement";

export default function TemplatesSettingsPage() {
  const { course_id } = useParams();
  const router = useRouter();
  const canManageOfficeHours = useCapabilityOnceLoaded("manage_office_hours");

  useEffect(() => {
    if (canManageOfficeHours === false) {
      toaster.create({
        title: "Permission denied",
        description: "You need manage_office_hours to edit help request templates.",
        type: "error"
      });
      router.replace(`/course/${course_id}/manage/office-hours`);
    }
  }, [canManageOfficeHours, course_id, router]);

  if (canManageOfficeHours !== true) {
    return (
      <Box display="flex" justifyContent="center" py={12}>
        <Spinner />
      </Box>
    );
  }

  return <HelpRequestTemplateManagement />;
}
