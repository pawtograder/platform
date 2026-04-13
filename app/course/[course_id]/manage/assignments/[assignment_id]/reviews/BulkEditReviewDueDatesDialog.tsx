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
import { Text, VStack } from "@chakra-ui/react";
import { Select } from "chakra-react-select";
import { useEffect, useMemo, useState } from "react";
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
  /** Rubrics the instructor may target in this dialog (e.g. all non–self-review, or only self-review) */
  rubrics: RubricRow[];
  triggerLabel?: string;
  dialogTitle?: string;
};

export default function BulkEditReviewDueDatesDialog({
  courseId,
  assignmentId,
  onSuccess,
  rubrics,
  triggerLabel = "Bulk edit due dates",
  dialogTitle = "Bulk edit review due dates"
}: BulkEditReviewDueDatesDialogProps) {
  const supabase = createClient();
  const [isOpen, setIsOpen] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [selectedRubric, setSelectedRubric] = useState<RubricRow | null>(null);
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const rubricOptions = useMemo(
    () =>
      rubrics.map((r) => ({
        value: r,
        label: `${r.name} (${reviewRoundLabel(r.review_round)})`
      })),
    [rubrics]
  );

  useEffect(() => {
    if (!isOpen) return;
    if (rubricOptions.length === 1) {
      setSelectedRubric(rubricOptions[0].value);
    } else {
      setSelectedRubric(null);
    }
  }, [isOpen, rubricOptions]);

  const handleApply = async () => {
    if (!dueDate) {
      toaster.error({ title: "Due date required", description: "Choose a date and time." });
      return;
    }
    if (!selectedRubric) {
      toaster.error({ title: "Rubric required", description: "Select which rubric to update." });
      return;
    }

    const isoDue = new Date(dueDate).toISOString();
    if (Number.isNaN(Date.parse(isoDue))) {
      toaster.error({ title: "Invalid date", description: "Could not parse the due date." });
      return;
    }

    setIsSaving(true);
    try {
      const { data, error } = await supabase.rpc("bulk_update_review_assignment_due_dates", {
        p_class_id: courseId,
        p_assignment_id: assignmentId,
        p_rubric_id: selectedRubric.id,
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
      setOnlyIncomplete(true);
    } finally {
      setIsSaving(false);
    }
  };

  const disabled = rubrics.length === 0;

  return (
    <DialogRoot open={isOpen} onOpenChange={(e) => setIsOpen(e.open)}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          title={disabled ? "No rubrics available for this scope" : undefined}
        >
          <MdEditCalendar style={{ marginRight: "8px" }} />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <VStack align="stretch" gap={4}>
            <Text fontSize="sm" color="fg.muted">
              Sets the same due date on review assignments for one rubric. Choose the rubric below (grading rounds and
              self-review are edited separately).
            </Text>
            <Field label="New due date (local)" required>
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
            </Field>
            <Field label="Rubric">
              <Select
                value={
                  selectedRubric
                    ? {
                        value: selectedRubric,
                        label: `${selectedRubric.name} (${reviewRoundLabel(selectedRubric.review_round)})`
                      }
                    : null
                }
                onChange={(opt) => {
                  setSelectedRubric(opt ? (opt.value as RubricRow) : null);
                }}
                options={rubricOptions}
                placeholder="Choose a rubric..."
                isClearable
              />
            </Field>
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
