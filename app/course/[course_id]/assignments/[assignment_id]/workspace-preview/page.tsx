"use client";

import { WorkspaceStatus } from "@/components/workspace/WorkspaceStatus";
import { useCourse } from "@/hooks/useCourseController";
import { createSimulatedWorkspaceClient, WORKSPACE_STEPS, WorkspaceStepId } from "@/lib/workspaceStatus";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Box, Heading, Text } from "@chakra-ui/react";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo } from "react";

// Not in COURSE_FEATURES yet: CW-10 (#1128) owns adding it. Like its SQL check, only a boolean
// true counts as on.
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
  const stepMs = Number(searchParams.get("stepMs")) || undefined;

  const client = useMemo(
    () => createSimulatedWorkspaceClient({ failAt: isStepId(fail) ? fail : undefined, stepMs }),
    [fail, stepMs]
  );

  const enabled =
    Array.isArray(course.features) &&
    course.features.some((f) => f?.name === CLOUD_WORKSPACES_FLAG && f.enabled === true);
  if (!enabled) {
    return (
      <Box m={4}>
        <Text>Cloud Workspaces is not turned on for this course.</Text>
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
      <WorkspaceStatus assignmentId={Number(assignment_id)} client={client} />
    </Box>
  );
}
