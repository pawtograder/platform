"use client";

import { Switch } from "@/components/ui/switch";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  courseFeatureEffectiveEnabled,
  MANAGEABLE_COURSE_FEATURES,
  type CourseFeatureName
} from "@/lib/courseFeatures";
import { createClient } from "@/utils/supabase/client";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Box, Card, Heading, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

function buildFlagsFromRole(
  features: { name: string; enabled: boolean }[] | null | undefined
): Record<CourseFeatureName, boolean> {
  const out = {} as Record<CourseFeatureName, boolean>;
  for (const def of MANAGEABLE_COURSE_FEATURES) {
    out[def.name] = courseFeatureEffectiveEnabled(features, def.name, def.defaultWhenMissing);
  }
  return out;
}

export default function CourseFeatureFlagsPage() {
  const { course_id } = useParams();
  const { role } = useClassProfiles();
  const courseIdNum = Number.parseInt(course_id as string, 10);
  const features = (role.classes as CourseWithFeatures).features;
  const featuresSnapshot = useMemo(() => JSON.stringify(features ?? null), [features]);

  const derivedFlags = useMemo(() => {
    const parsed =
      featuresSnapshot === "null"
        ? null
        : (JSON.parse(featuresSnapshot) as { name: string; enabled: boolean }[] | null);
    return buildFlagsFromRole(parsed);
  }, [featuresSnapshot]);
  const [flags, setFlags] = useState<Record<CourseFeatureName, boolean>>(derivedFlags);
  const [savingName, setSavingName] = useState<CourseFeatureName | null>(null);

  useEffect(() => {
    const parsed =
      featuresSnapshot === "null"
        ? null
        : (JSON.parse(featuresSnapshot) as { name: string; enabled: boolean }[] | null);
    setFlags(buildFlagsFromRole(parsed));
  }, [featuresSnapshot]);

  const onFlagChange = useCallback(
    async (name: CourseFeatureName, checked: boolean) => {
      if (Number.isNaN(courseIdNum)) {
        toaster.error({ title: "Invalid course" });
        return;
      }
      const rollback = buildFlagsFromRole(features);
      setSavingName(name);
      try {
        const supabase = createClient();
        const { error } = await supabase.rpc("merge_class_feature", {
          p_class_id: courseIdNum,
          p_name: name,
          p_enabled: checked
        });
        if (error) {
          throw new Error(error.message);
        }
        setFlags((prev) => ({ ...prev, [name]: checked }));
        toaster.success({ title: "Saved" });
      } catch (e) {
        toaster.error({
          title: "Could not update feature",
          description: e instanceof Error ? e.message : "Unknown error"
        });
        setFlags(rollback);
      } finally {
        setSavingName(null);
      }
    },
    [courseIdNum, features]
  );

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
            Turn course features on or off. Navigation and student tools respect these flags; staff may need direct URLs
            when a menu entry is hidden. Changes apply after people refresh the page.
          </Text>
        </Box>

        {MANAGEABLE_COURSE_FEATURES.map((def) => (
          <Card.Root key={def.name}>
            <Card.Body>
              <Heading size="sm" mb={2}>
                {def.title}
              </Heading>
              <Text fontSize="sm" color="fg.muted" mb={2}>
                {def.description}
              </Text>
              {def.navAffectsStaff ? (
                <Text fontSize="xs" color="fg.muted" mb={4}>
                  This flag also hides matching entries from the staff course menu (not only students).
                </Text>
              ) : null}
              <Switch
                checked={flags[def.name]}
                disabled={savingName === def.name}
                onCheckedChange={(e: { checked: boolean }) => onFlagChange(def.name, e.checked)}
                inputProps={{
                  "aria-label": def.ariaLabel
                }}
              >
                {def.switchLabel}
              </Switch>
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>
    </Box>
  );
}
