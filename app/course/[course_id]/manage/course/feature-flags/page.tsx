"use client";

import { AutoGroupPreviewDialog } from "@/components/gradebook/AutoGroupPreviewDialog";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import {
  COURSE_FEATURES,
  courseFeatureEffectiveEnabled,
  MANAGEABLE_COURSE_FEATURES,
  type CourseFeatureName
} from "@/lib/courseFeatures";
import { GIT_PROVIDER_LABELS, type GitProviderName } from "@/lib/gitProviderOptions";
import { createClient } from "@/utils/supabase/client";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Box, Card, Heading, NativeSelect, Text, VStack } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getUserFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { useStaffErrorRole } from "@/hooks/useStaffErrorRole";

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
  const errorRole = useStaffErrorRole();
  const { course_id } = useParams();
  const router = useRouter();
  const { role } = useClassProfiles();
  // The flags come from the live course row, not from role.classes. role.classes is the snapshot
  // taken when the role was loaded, so another instructor's change never reached this page and the
  // switches stayed on the old values until a manual refresh (#1062). useCourse() is backed by
  // CourseProvider's classes_update subscription, which is why Enrollments already updates live.
  const course = useCourse();
  const courseIdNum = Number.parseInt(course_id as string, 10);
  const features = (course as CourseWithFeatures).features;
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
  // Turning column groups on goes through a preview of the groups it would create.
  const [isPreviewingGroups, setIsPreviewingGroups] = useState(false);
  const gradebookId = (course as CourseWithFeatures).gradebook_id ?? null;

  const rawDefaultProvider = (course as CourseWithFeatures).default_git_provider;
  const courseDefaultProvider: "" | GitProviderName =
    rawDefaultProvider === "github" || rawDefaultProvider === "forgejo" ? rawDefaultProvider : "";
  const automaticDefaultLabel = (course as CourseWithFeatures).github_org?.trim()
    ? "Automatic (GitHub)"
    : "Automatic (Forgejo)";
  const [defaultGitProvider, setDefaultGitProvider] = useState<"" | GitProviderName>(courseDefaultProvider);
  const [savingDefaultProvider, setSavingDefaultProvider] = useState(false);

  useEffect(() => {
    setDefaultGitProvider(courseDefaultProvider);
  }, [courseDefaultProvider]);

  const onDefaultGitProviderChange = useCallback(
    async (nextValue: "" | GitProviderName) => {
      if (Number.isNaN(courseIdNum)) {
        toaster.error({ title: "Invalid course" });
        return;
      }
      const previous = defaultGitProvider;
      setDefaultGitProvider(nextValue);
      setSavingDefaultProvider(true);
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("classes")
          .update({ default_git_provider: nextValue === "" ? null : nextValue })
          .eq("id", courseIdNum)
          .select("id");
        if (error) {
          throw new Error(error.message);
        }
        if (!data || data.length === 0) {
          throw new Error("Could not update the default repository host.");
        }
        router.refresh();
        toaster.success({ title: "Saved" });
      } catch (e) {
        setDefaultGitProvider(previous);
        toaster.error({
          title: "Could not update default repository host",
          description: getUserFacingErrorMessage(e, { role: errorRole })
        });
      } finally {
        setSavingDefaultProvider(false);
      }
    },
    [courseIdNum, defaultGitProvider, errorRole, router]
  );

  const enableColumnGroups = useCallback(async () => {
    const supabase = createClient();
    const { error } = await supabase.rpc("gradebook_enable_column_groups", { p_class_id: courseIdNum });
    if (error) throw new Error(error.message);
    setFlags((prev) => ({ ...prev, [COURSE_FEATURES.GRADEBOOK_COLUMN_GROUPS]: true }));
    router.refresh();
    toaster.success({ title: "Column groups turned on" });
  }, [courseIdNum, router]);

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
        router.refresh();
        toaster.success({ title: "Saved" });
      } catch (e) {
        toaster.error({
          title: "Could not update feature",
          description: getUserFacingErrorMessage(e, { role: errorRole })
        });
        setFlags(rollback);
      } finally {
        setSavingName(null);
      }
    },
    [errorRole, courseIdNum, features, router]
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
            Turn course features on or off. Navigation, dashboards, and student tools update automatically when these
            flags change; staff may need direct URLs when a menu entry is hidden.
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
                onCheckedChange={(e: { checked: boolean }) =>
                  def.name === COURSE_FEATURES.GRADEBOOK_COLUMN_GROUPS && e.checked
                    ? setIsPreviewingGroups(true)
                    : onFlagChange(def.name, e.checked)
                }
                inputProps={{
                  "aria-label": def.ariaLabel
                }}
              >
                {def.switchLabel}
              </Switch>
              {def.name === COURSE_FEATURES.CLOUD_WORKSPACES ? (
                <Box mt={4} pt={4} borderTopWidth="1px" borderColor="border.muted">
                  <Field
                    label="Default repository host for new assignments"
                    helperText={
                      flags[COURSE_FEATURES.CLOUD_WORKSPACES]
                        ? "Pre-selected when creating a new code assignment. Existing assignments and manual choices on the form are unchanged."
                        : "Applies only while Cloud workspaces is enabled. While it is off, new assignments default to GitHub."
                    }
                  >
                    <NativeSelect.Root maxW="xs" disabled={savingDefaultProvider}>
                      <NativeSelect.Field
                        aria-label="Default repository host for new assignments"
                        value={defaultGitProvider}
                        onChange={(e) => onDefaultGitProviderChange(e.target.value as "" | GitProviderName)}
                      >
                        <option value="">{automaticDefaultLabel}</option>
                        <option value="github">{GIT_PROVIDER_LABELS.github}</option>
                        <option value="forgejo">{GIT_PROVIDER_LABELS.forgejo}</option>
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  </Field>
                </Box>
              ) : null}
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>
      <AutoGroupPreviewDialog
        open={isPreviewingGroups}
        gradebookId={gradebookId}
        title="Turn on gradebook column groups"
        confirmLabel="Turn on"
        onConfirm={enableColumnGroups}
        onClose={() => setIsPreviewingGroups(false)}
      />
    </Box>
  );
}
