"use client";

import { Button } from "@/components/ui/button";
import {
  DialogActionTrigger,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { useMemo, useState } from "react";
import { MdEditCalendar } from "react-icons/md";

type RubricRow = Pick<Database["public"]["Tables"]["rubrics"]["Row"], "id" | "name" | "review_round">;

function reviewRoundLabel(round: string | null | undefined): string {
  switch (round) {
    case "self-review":
      return "Self-review";
    case "grading-review":
      return "Grading review";
    case "meta-grading-review":
      return "Meta-grading";
    case "code-walk":
      return "Code walk";
    default:
      return round ?? "Unknown";
  }
}

type BulkEditReviewDueDatesDialogProps = {
  courseId: number;
  assignmentId: number;
  onSuccess: () => void;
};

export default function BulkEditReviewDueDatesDialog({
  courseId,
  assignmentId,
  onSuccess
}: BulkEditReviewDueDatesDialogProps) {
  const supabase = createClient();
  const [isOpen, setIsOpen] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [selectedRubric, setSelectedRubric] = useState<RubricRow | "all" | null>("all");
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const { data: rubricsData, isLoading: rubricsLoading } = useList<RubricRow>({
    resource: "rubrics",
    filters: [
      { field: "class_id", operator: "eq", value: courseId },
      { field: "assignment_id", operator: "eq", value: assignmentId }
    ],
    meta: { select: "id, name, review_round" },
    queryOptions: { enabled: isOpen && !!courseId && !!assignmentId }
  });

  const rubricOptions = useMemo(() => {
    const rows = rubricsData?.data ?? [];
    return [
      {
        value: "all" as const,
        label: "All rubrics (self-review and grading)"
      },
      ...rows.map((r) => ({
        value: r,
        label: `${r.name} (${reviewRoundLabel(r.review_round)})`
      }))
    ];
  }, [rubricsData?.data]);

  const handleApply = async () => {
    if (!dueDate) {
      toaster.error({ title: "Due date required", description: "Choose a date and time." });
      return;
    }

    const isoDue = new Date(dueDate).toISOString();
    if (Number.isNaN(Date.parse(isoDue))) {
      toaster.error({ title: "Invalid date", description: "Could not parse the due date." });
      return;
    }

    setIsSaving(true);
    try {
      const p_rubric_id = selectedRubric && selectedRubric !== "all" ? (selectedRubric as RubricRow).id : null;

      const { data, error } = await supabase.rpc("bulk_update_review_assignment_due_dates", {
        p_class_id: courseId,
        p_assignment_id: assignmentId,
        p_rubric_id,
        p_due_date: isoDue,
        p_only_incomplete: onlyIncomplete
      });

      if (error) {
        toaster.error({ title: "Could not update due dates", description: error.message });
        return;
      }

      const payload = data as { success?: boolean; updated?: number } | null;
      const n = typeof payload?.updated === "number" ? payload.updated : 0;
      toaster.success({
        title: "Due dates updated",
        description:
          n === 0
            ? "No rows matched (you may have filtered to completed reviews only)."
            : `Updated ${n} review assignment${n === 1 ? "" : "s"}.`
      });
      onSuccess();
      setIsOpen(false);
      setDueDate("");
      setSelectedRubric("all");
      setOnlyIncomplete(true);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => setIsOpen(e.open)}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <MdEditCalendar style={{ marginRight: "8px" }} />
          Bulk edit due dates
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk edit review due dates</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <VStack align="stretch" gap={4}>
            <Text fontSize="sm" color="fg.muted">
              Sets the same due date on multiple review assignments for this homework. You can target all rubrics or a
              single rubric (including self-review).
            </Text>
            <Field.Root required>
              <Field.Label>New due date (local)</Field.Label>
              <input
                type="datetime-local"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "6px",
                  border: "1px solid var(--chakra-colors-border)"
                }}
              />
            </Field.Root>
            <Box>
              <Field.Label>Rubric</Field.Label>
              <Select
                isLoading={rubricsLoading}
                value={
                  selectedRubric === "all" || selectedRubric === null
                    ? rubricOptions[0]
                    : {
                        value: selectedRubric as RubricRow,
                        label: `${(selectedRubric as RubricRow).name} (${reviewRoundLabel((selectedRubric as RubricRow).review_round)})`
                      }
                }
                onChange={(opt) => {
                  if (!opt) return;
                  if (opt.value === "all") setSelectedRubric("all");
                  else setSelectedRubric(opt.value as RubricRow);
                }}
                options={rubricOptions}
                placeholder="Choose scope..."
              />
            </Box>
            <Checkbox checked={onlyIncomplete} onCheckedChange={({ checked }) => setOnlyIncomplete(!!checked)}>
              Only rows not yet completed
            </Checkbox>
          </VStack>
        </DialogBody>
        <DialogFooter>
          <DialogActionTrigger asChild>
            <Button variant="outline">Cancel</Button>
          </DialogActionTrigger>
          <Button colorPalette="green" loading={isSaving} onClick={() => void handleApply()}>
            Apply to matching rows
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
