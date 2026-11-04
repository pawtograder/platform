"use client";

import { WorkspaceStatus } from "@/components/workspace/WorkspaceStatus";
import { useCourse } from "@/hooks/useCourseController";
import { createSimulatedWorkspaceClient, WORKSPACE_STEPS, WorkspaceStepId } from "@/lib/workspaceStatus";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Text } from "@chakra-ui/react";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo } from "react";

// Not in COURSE_FEATURES yet: CW-10 (#1128) owns adding it. Like its SQL check and
// `courseFeatureEffectiveEnabled`, the first matching entry decides, and only a boolean true counts
// as on. Once #1128 merges, this can call `courseFeatureEnabled`.
const CLOUD_WORKSPACES_FLAG = "cloud-workspaces";

function isStepId(value: string | null): value is WorkspaceStepId {
  return WORKSPACE_STEPS.some((s) => s.id === value);
}

/**
 * Preview of the workspace card against a simulated Coder, until the `workspace-open` function
 * exists. `?fail=<step>` makes that step fail; `?stepMs=` sets how long each step takes.
 */
export default function WorkspacePreviewPage() {
  const course = useCourse() as CourseWithFeatures;
  const { assignment_id } = useParams<{ assignment_id: string }>();
  const searchParams = useSearchParams();
  const fail = searchParams.get("fail");
  // The simulated client falls back to its default for anything that is not a positive number.
  const stepMs = Number(searchParams.get("stepMs")) || undefined;
  const assignmentId = Number(assignment_id);

  const client = useMemo(
    () => createSimulatedWorkspaceClient({ failAt: isStepId(fail) ? fail : undefined, stepMs }),
    [fail, stepMs]
  );

  const enabled =
    Array.isArray(course.features) && course.features.find((f) => f?.name === CLOUD_WORKSPACES_FLAG)?.enabled === true;
  if (!enabled) {
    return (
      <Box m={4}>
        <Text>Cloud Workspaces is not turned on for this course.</Text>
      </Box>
    );
  }

  if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
    return (
      <Box m={4}>
        <Text>Assignment not found.</Text>
      </Box>
    );
  }

  return (
    <Box m={4}>
      <Heading size="lg" mb={1}>
        Workspace preview
      </Heading>
      <Text fontSize="sm" color="fg.muted" mb={4}>
        Simulated: no workspace is created. This shows what students will see while theirs starts.
      </Text>
      <WorkspaceStatus assignmentId={assignmentId} client={client} />
    </Box>
  );
}
