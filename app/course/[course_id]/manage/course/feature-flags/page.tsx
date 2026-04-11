"use client";

import { Switch } from "@/components/ui/switch";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { COURSE_FEATURES } from "@/lib/courseFeatures";
import { createClient } from "@/utils/supabase/client";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Box, Card, Heading, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function CourseFeatureFlagsPage() {
  const { course_id } = useParams();
  const { role } = useClassProfiles();
  const courseIdNum = Number.parseInt(course_id as string, 10);
  const features = (role.classes as CourseWithFeatures).features;
  const fromRole = features?.find((f) => f.name === COURSE_FEATURES.GRADEBOOK_WHAT_IF)?.enabled === true;
  const [whatIfEnabled, setWhatIfEnabled] = useState(fromRole);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWhatIfEnabled(fromRole);
  }, [fromRole]);

  const onWhatIfChange = async (checked: boolean) => {
    if (Number.isNaN(courseIdNum)) {
      toaster.error({ title: "Invalid course" });
      return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc("merge_class_feature", {
        p_class_id: courseIdNum,
        p_name: COURSE_FEATURES.GRADEBOOK_WHAT_IF,
        p_enabled: checked
      });
      if (error) {
        throw new Error(error.message);
      }
      setWhatIfEnabled(checked);
      toaster.success({
        title: "Saved",
        description: checked ? "Students can use What-If on the gradebook." : "Student gradebook What-If is turned off."
      });
    } catch (e) {
      toaster.error({
        title: "Could not update feature",
        description: e instanceof Error ? e.message : "Unknown error"
      });
      setWhatIfEnabled(fromRole);
    } finally {
      setSaving(false);
    }
  };

  if (!role || role.role !== "instructor") {
    return (
      <Box p={6}>
        <Text>Access denied. This page is only available to instructors.</Text>
      </Box>
    );
  }

  return (
    <Box p={4} maxW="xl">
      <VStack align="stretch" gap={6}>
        <Box>
          <Heading size="lg">Feature flags</Heading>
          <Text fontSize="sm" color="fg.muted" mt={1}>
            Turn course features on or off for students. Changes apply after students refresh the page.
          </Text>
        </Box>

        <Card.Root>
          <Card.Body>
            <Heading size="sm" mb={2}>
              Student gradebook What-If
            </Heading>
            <Text fontSize="sm" color="fg.muted" mb={4}>
              When enabled, students can tap released grades to simulate hypothetical scores; calculated columns update
              from those simulations. When disabled, the gradebook is view-only for students.
            </Text>
            <Switch
              checked={whatIfEnabled}
              disabled={saving}
              onCheckedChange={(e: { checked: boolean }) => onWhatIfChange(e.checked)}
              inputProps={{
                "aria-label": "Enable student gradebook What-If"
              }}
            >
              Allow What-If grade simulations for students
            </Switch>
          </Card.Body>
        </Card.Root>
      </VStack>
    </Box>
  );
}
