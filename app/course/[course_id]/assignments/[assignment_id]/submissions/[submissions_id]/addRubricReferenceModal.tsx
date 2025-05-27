"use client";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import type { HydratedRubric, HydratedRubricCheck } from "@/utils/supabase/DatabaseTypes";
import { Spinner, Text, VStack } from "@chakra-ui/react"; // Keep Chakra for layout if used elsewhere
import { useCreate, useList } from "@refinedev/core";
import { Select as ChakraReactSelect, type OptionBase } from "chakra-react-select";
import { useEffect, useMemo, useState } from "react";
import { FaPlus } from "react-icons/fa";

interface RubricOptionType extends OptionBase {
  value: number;
  label: string;
}

interface CheckOptionType extends OptionBase {
  value: number;
  label: string;
}

type AddRubricReferenceModalProps = {
  isOpen: boolean;
  onClose: () => void;
  currentRubricChecks: HydratedRubricCheck[];
  currentRubricId: number;
  assignmentId: number;
  classId: number;
};

export default function AddRubricReferenceModal({
  isOpen,
  onClose,
  currentRubricChecks,
  currentRubricId,
  assignmentId,
  classId
}: AddRubricReferenceModalProps) {
  const [selectedReferencingCheckOption, setSelectedReferencingCheckOption] = useState<CheckOptionType | undefined>(
    undefined
  );
  const [selectedRubricOption, setSelectedRubricOption] = useState<RubricOptionType | undefined>(undefined);
  const [selectedCheckOption, setSelectedCheckOption] = useState<CheckOptionType | undefined>(undefined);
  const [isCreating, setIsCreating] = useState(false);

  const { data: rubricsData, isLoading: isLoadingRubrics } = useList<HydratedRubric>({
    resource: "rubrics",
    filters: [
      { field: "assignment_id", operator: "eq", value: assignmentId },
      { field: "id", operator: "ne", value: currentRubricId } // Corrected operator
    ],
    meta: {
      select: "id, name, review_round, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))"
    },
    queryOptions: {
      enabled: isOpen && !!assignmentId && !!currentRubricId
    }
  });

  const { mutate: createReference } = useCreate();

  const referencingCheckOptions: CheckOptionType[] = useMemo(() => {
    return currentRubricChecks.map((check) => ({
      value: check.id,
      label: `${check.name} (Points: ${check.points})`
    }));
  }, [currentRubricChecks]);

  const rubricOptions: RubricOptionType[] = useMemo(() => {
    return (
      rubricsData?.data.map((rubric) => ({
        value: rubric.id,
        label: `${rubric.name} (${rubric.review_round || "General"})`
      })) || []
    );
  }, [rubricsData]);

  const referencedCheckOptions: CheckOptionType[] = useMemo(() => {
    if (!selectedRubricOption) return [];
    const selectedRubric = rubricsData?.data.find((r) => r.id === selectedRubricOption.value);
    if (!selectedRubric) return [];

    const checks: HydratedRubricCheck[] = [];
    selectedRubric.rubric_parts.forEach((part) => {
      part.rubric_criteria.forEach((criteria) => {
        checks.push(...criteria.rubric_checks);
      });
    });
    return checks.map((check) => ({
      value: check.id,
      label: `${check.name} (Points: ${check.points})`
    }));
  }, [selectedRubricOption, rubricsData?.data]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedReferencingCheckOption(undefined);
      setSelectedRubricOption(undefined);
      setSelectedCheckOption(undefined);
    }
  }, [isOpen]);

  const handleSubmit = () => {
    if (!selectedReferencingCheckOption?.value) {
      toaster.create({
        title: "Error",
        description: "Please select the check from the current rubric that will make the reference.",
        type: "error"
      });
      return;
    }
    if (!selectedCheckOption?.value) {
      toaster.create({
        title: "Error",
        description: "Please select a rubric check to reference.",
        type: "error"
      });
      return;
    }
    setIsCreating(true);
    createReference(
      {
        resource: "rubric_check_references",
        values: {
          referencing_rubric_check_id: selectedReferencingCheckOption.value,
          referenced_rubric_check_id: selectedCheckOption.value,
          class_id: classId
        }
      },
      {
        onSuccess: () => {
          toaster.success({
            title: "Reference Added",
            description: "The rubric check reference has been added successfully."
          });
          onClose();
        },
        onError: (error) => {
          toaster.error({
            title: "Error Adding Reference",
            description: error.message
          });
        },
        onSettled: () => {
          setIsCreating(false);
        }
      }
    );
  };

  return (
    <DialogRoot open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <DialogContent maxW="xl">
        <DialogHeader>
          <DialogTitle>Reference Another Rubric Check</DialogTitle>
          <DialogCloseTrigger aria-label="Close dialog">
            <FaPlus style={{ transform: "rotate(45deg)" }} />
          </DialogCloseTrigger>
        </DialogHeader>
        <DialogBody>
          {isLoadingRubrics && !referencingCheckOptions.length ? (
            <VStack>
              <Spinner />
              <Text>Loading available checks...</Text>
            </VStack>
          ) : (
            <VStack gap={4}>
              <Field label="Select Check from THIS Rubric (Referencing Check)">
                <ChakraReactSelect<CheckOptionType, false>
                  inputId="select-referencing-check"
                  options={referencingCheckOptions}
                  value={selectedReferencingCheckOption}
                  onChange={(option) => setSelectedReferencingCheckOption(option || undefined)}
                  placeholder="Select check from current rubric..."
                  chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 10000 }) }}
                />
              </Field>

              <Field label="Select Rubric to Reference From (Referenced Rubric)">
                <ChakraReactSelect<RubricOptionType, false>
                  inputId="select-rubric-reference"
                  options={rubricOptions}
                  value={selectedRubricOption}
                  onChange={(option) => {
                    setSelectedRubricOption(option || undefined);
                    setSelectedCheckOption(undefined);
                  }}
                  isLoading={isLoadingRubrics}
                  placeholder="Select other rubric..."
                  isDisabled={!selectedReferencingCheckOption}
                  chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 9999 }) }}
                />
              </Field>

              {selectedRubricOption && (
                <Field label="Select Check to Reference (Referenced Check)">
                  <ChakraReactSelect<CheckOptionType, false>
                    inputId="select-check-reference"
                    options={referencedCheckOptions}
                    value={selectedCheckOption}
                    onChange={(option) => setSelectedCheckOption(option || undefined)}
                    isDisabled={referencedCheckOptions.length === 0 || isLoadingRubrics}
                    placeholder="Select check from other rubric..."
                    chakraStyles={{ menu: (provided) => ({ ...provided, zIndex: 9999 }) }}
                  />
                  {referencedCheckOptions.length === 0 && !isLoadingRubrics && (
                    <Text fontSize="sm" color="gray.500" mt={1}>
                      No checks available in the selected rubric.
                    </Text>
                  )}
                </Field>
              )}
            </VStack>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" colorPalette="red" mr={3} onClick={onClose}>
            Cancel
          </Button>
          <Button
            colorPalette="green"
            onClick={handleSubmit}
            loading={isCreating}
            disabled={!selectedReferencingCheckOption || !selectedCheckOption || isLoadingRubrics || isCreating}
          >
            Add Reference
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
