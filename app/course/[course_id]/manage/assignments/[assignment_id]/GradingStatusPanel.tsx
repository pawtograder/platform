"use client";

import { computeGradingCounts, type GradingStatusRow } from "@/lib/assignmentDashboardStats";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Button, CardBody, CardRoot, HStack, Popover, Text, VStack } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import FinalizeGradingButton from "./FinalizeGradingButton";

type ReleaseAllRpc = "release_all_grading_reviews_for_assignment" | "unrelease_all_grading_reviews_for_assignment";

/**
 * A button that opens a confirmation popover before running a destructive /
 * far-reaching assignment-level action (release-all / unrelease-all).
 */
function ConfirmButton({
  label,
  confirmTitle,
  confirmBody,
  colorPalette,
  onConfirm
}: {
  label: string;
  confirmTitle: string;
  confirmBody: string;
  colorPalette?: string;
  onConfirm: () => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  return (
    <Popover.Root open={isOpen} onOpenChange={(e) => setIsOpen(e.open)}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="subtle" colorPalette={colorPalette} loading={isRunning}>
          {label}
        </Button>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <Popover.Arrow>
            <Popover.ArrowTip />
          </Popover.Arrow>
          <Popover.Header>{confirmTitle}</Popover.Header>
          <Popover.Body>
            <VStack align="stretch" gap={3}>
              <Text>{confirmBody}</Text>
              <HStack justify="flex-end" gap={2}>
                <Button size="sm" variant="ghost" onClick={() => setIsOpen(false)} disabled={isRunning}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  colorPalette={colorPalette}
                  loading={isRunning}
                  onClick={async () => {
                    setIsRunning(true);
                    try {
                      await onConfirm();
                      setIsOpen(false);
                    } finally {
                      setIsRunning(false);
                    }
                  }}
                >
                  {label}
                </Button>
              </HStack>
            </VStack>
          </Popover.Body>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
}

/**
 * Dashboard panel summarizing grading progress for an assignment and hosting the
 * assignment-level grading actions: Finalize grading, Release all, Unrelease all.
 * Per-submission release/unrelease remains contextual in the submissions table.
 */
export default function GradingStatusPanel({
  rows,
  assignmentId,
  supabase,
  onChanged
}: {
  rows: readonly GradingStatusRow[];
  assignmentId: number;
  supabase: ReturnType<typeof createClient>;
  onChanged?: () => void | Promise<void>;
}) {
  const counts = useMemo(() => computeGradingCounts(rows), [rows]);

  const runReleaseAll = async (rpc: ReleaseAllRpc, successVerb: string) => {
    const { data, error } = await supabase.rpc(rpc, { assignment_id: assignmentId });
    if (error) {
      toaster.error({ title: "Error", description: error.message });
      return;
    }
    await onChanged?.();
    const count = typeof data === "number" ? data : 0;
    toaster.success({
      title: "Success",
      description: `${count} submission review(s) ${successVerb}`
    });
  };

  return (
    <CardRoot>
      <CardBody py={2.5}>
        <HStack justify="space-between" align="center" wrap="wrap" gap={3}>
          <HStack gap={5} wrap="wrap">
            <Text fontSize="sm">
              <Text as="span" color="fg.muted">
                Graded
              </Text>{" "}
              <Text as="span" fontWeight="semibold">
                {counts.graded}/{counts.total}
              </Text>
            </Text>
            <Text fontSize="sm">
              <Text as="span" color="fg.muted">
                Released
              </Text>{" "}
              <Text as="span" fontWeight="semibold">
                {counts.released}/{counts.total}
              </Text>
            </Text>
          </HStack>
          <HStack gap={2} wrap="wrap">
            <FinalizeGradingButton assignmentId={assignmentId} supabase={supabase} onCompleted={onChanged} />
            <ConfirmButton
              label="Release all"
              colorPalette="green"
              confirmTitle="Release all grading reviews"
              confirmBody="This will release the grading reviews for every submission in this assignment, making grades visible to all students. Continue?"
              onConfirm={() => runReleaseAll("release_all_grading_reviews_for_assignment", "released")}
            />
            <ConfirmButton
              label="Unrelease all"
              colorPalette="red"
              confirmTitle="Unrelease all grading reviews"
              confirmBody="This will hide grades from all students for every submission in this assignment. Continue?"
              onConfirm={() => runReleaseAll("unrelease_all_grading_reviews_for_assignment", "unreleased")}
            />
          </HStack>
        </HStack>
      </CardBody>
    </CardRoot>
  );
}
