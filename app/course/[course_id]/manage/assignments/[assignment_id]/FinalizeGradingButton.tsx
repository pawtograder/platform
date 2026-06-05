"use client";

import { toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, HStack, Icon, IconButton, Popover, Spinner, Text, VStack } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { BsCheck, BsX } from "react-icons/bs";

type EligibilityData = {
  total_incomplete: number;
  completable: number;
  missing_required_checks: number;
};

/**
 * Assignment-level "Finalize grading" action. Finalizes every grading review that
 * is eligible to be completed for the assignment (i.e. has all required rubric
 * checks). Shows an eligibility preview before confirming. This is intentionally
 * NOT scoped to a row selection — it acts on all eligible reviews at once.
 */
export default function FinalizeGradingButton({
  assignmentId,
  supabase,
  onCompleted,
  disabled,
  tooltip
}: {
  assignmentId: number;
  supabase: ReturnType<typeof createClient>;
  onCompleted?: () => void | Promise<void>;
  disabled?: boolean;
  tooltip?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [eligibilityData, setEligibilityData] = useState<EligibilityData | null>(null);
  const [isCheckingEligibility, setIsCheckingEligibility] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const run = async () => {
      setIsCheckingEligibility(true);
      setEligibilityData(null);
      try {
        const { data, error } = await supabase.rpc("check_grading_completion_eligibility", {
          p_assignment_id: assignmentId
        });
        if (cancelled) return;
        if (error) {
          toaster.error({ title: "Error", description: error.message });
          return;
        }
        const row = Array.isArray(data) ? data[0] : null;
        if (row && typeof row === "object" && "total_incomplete" in row) {
          setEligibilityData({
            total_incomplete: Number(row.total_incomplete ?? 0),
            completable: Number(row.completable ?? 0),
            missing_required_checks: Number(row.missing_required_checks ?? 0)
          });
        } else {
          setEligibilityData({ total_incomplete: 0, completable: 0, missing_required_checks: 0 });
        }
      } finally {
        if (!cancelled) setIsCheckingEligibility(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [isOpen, assignmentId, supabase]);

  const handleConfirm = async () => {
    setIsFinalizing(true);
    setIsOpen(false);
    try {
      const { data, error } = await supabase.rpc("complete_eligible_grading_reviews", {
        p_assignment_id: assignmentId
      });
      if (error) throw new Error(error.message);
      await onCompleted?.();
      const count = typeof data === "number" ? data : 0;
      toaster.success({
        title: "Success",
        description:
          count > 0 ? `${count} submission review(s) marked as complete` : "No reviews were eligible to mark complete"
      });
    } catch (error) {
      toaster.error({
        title: "Error",
        description: error instanceof Error ? error.message : "Unknown error occurred"
      });
    } finally {
      setIsFinalizing(false);
    }
  };

  const canComplete = (eligibilityData?.completable ?? 0) > 0;

  const popover = (
    <Popover.Root open={isOpen} onOpenChange={(e) => setIsOpen(e.open)}>
      <Popover.Trigger asChild>
        <Button colorPalette="blue" variant="subtle" size="sm" loading={isFinalizing} disabled={disabled}>
          Finalize grading
        </Button>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <Popover.Arrow>
            <Popover.ArrowTip />
          </Popover.Arrow>
          <Popover.Header>Finalize grading</Popover.Header>
          <Popover.Body>
            {isCheckingEligibility ? (
              <HStack gap={2}>
                <Spinner size="sm" />
                <Text>Checking which submissions can be finalized...</Text>
              </HStack>
            ) : eligibilityData ? (
              <VStack align="stretch" gap={3}>
                <Text>
                  {eligibilityData.total_incomplete === 0
                    ? "All submission reviews are already complete."
                    : eligibilityData.completable > 0
                      ? `${eligibilityData.completable} of ${eligibilityData.total_incomplete} incomplete submission(s) can be finalized.`
                      : "No incomplete submissions can be finalized."}
                </Text>
                {eligibilityData.missing_required_checks > 0 && (
                  <Text color="fg.muted">
                    {eligibilityData.missing_required_checks} submission(s) have missing required rubric checks.
                  </Text>
                )}
                <HStack justify="flex-end" gap={2}>
                  <IconButton aria-label="Cancel" variant="ghost" size="sm" onClick={() => setIsOpen(false)}>
                    <Icon as={BsX} boxSize={5} />
                  </IconButton>
                  <IconButton
                    aria-label="Confirm finalize grading"
                    variant="solid"
                    size="sm"
                    disabled={!canComplete}
                    loading={isFinalizing}
                    onClick={handleConfirm}
                  >
                    <Icon as={BsCheck} boxSize={5} />
                  </IconButton>
                </HStack>
              </VStack>
            ) : (
              <Text>Unable to load eligibility.</Text>
            )}
          </Popover.Body>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );

  if (!tooltip) return popover;
  return (
    <Tooltip content={tooltip} showArrow positioning={{ placement: "top" }}>
      <Box as="span" display="inline-flex">
        {popover}
      </Box>
    </Tooltip>
  );
}
