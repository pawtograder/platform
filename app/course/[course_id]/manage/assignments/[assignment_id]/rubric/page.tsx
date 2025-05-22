"use client";
import { Alert } from "@/components/ui/alert";
import { useColorMode } from "@/components/ui/color-mode";
import RubricSidebar from "@/components/ui/rubric-sidebar";
import { toaster, Toaster } from "@/components/ui/toaster";
import {
  Assignment,
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  RubricChecksDataType,
  YmlRubricChecksType,
  YmlRubricCriteriaType,
  YmlRubricPartType,
  YmlRubricType
} from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Center, Flex, Heading, HStack, List, Spinner, Tabs, Text, VStack } from "@chakra-ui/react";
import Editor, { Monaco } from "@monaco-editor/react";
import { useCreate, useDelete, useList, useShow, useUpdate, HttpError } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import * as YAML from "yaml";

const REVIEW_ROUNDS_AVAILABLE: Array<NonNullable<HydratedRubric["review_round"]>> = [
  "self-review",
  "grading-review",
  "meta-grading-review"
];

function findChanges<T extends { id: number | undefined | null }>(
  newItems: T[],
  existingItems: T[]
): {
  toCreate: T[];
  toUpdate: T[];
  toDelete: number[];
} {
  const existingItemMap = new Map(existingItems.map((item) => [item.id, item]));

  const toCreate: T[] = [];
  const toUpdate: T[] = [];

  for (const newItem of newItems) {
    if (newItem.id === undefined || newItem.id === null || newItem.id <= 0) {
      toCreate.push(newItem);
    } else {
      const existingItem = existingItemMap.get(newItem.id);
      if (existingItem) {
        if (JSON.stringify(newItem) !== JSON.stringify(existingItem)) {
          toUpdate.push(newItem);
        }
        existingItemMap.delete(newItem.id);
      } else {
        toaster.create({
          title: "Item not found in existing",
          description: `Item with ID ${newItem.id} found in new items but not in existing. Treating as new if ID > 0.`,
          type: "warning"
        });
        toCreate.push(newItem);
      }
    }
  }

  const toDelete: number[] = Array.from(existingItemMap.keys()).filter(
    (id): id is number => id !== undefined && id !== null && id > 0
  );

  return { toCreate, toUpdate, toDelete };
}

function rubricCheckDataOrThrow(check: YmlRubricChecksType): RubricChecksDataType | undefined {
  if (!check.data) {
    return undefined;
  }

  // Type guard for check.data
  if (
    typeof check.data === "object" &&
    check.data !== null &&
    "options" in check.data &&
    Array.isArray((check.data as { options?: unknown }).options)
  ) {
    const specificData = check.data as RubricChecksDataType;

    if (specificData.options?.length === 1) {
      throw new Error("Checks may not have only one option - they must have at least two options, or can have none");
    }
    for (const option of specificData.options) {
      if (option.points === undefined || option.points === null) {
        throw new Error("Option points are required");
      }
      if (!option.label) {
        throw new Error("Option label is required");
      }
    }
    return specificData;
  } else if (typeof check.data === "object" && check.data !== null && !("options" in check.data)) {
    return undefined;
  }

  return undefined;
}

function hydratedRubricChecksToYamlRubric(checks: HydratedRubricCheck[]): YmlRubricChecksType[] {
  return checks
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((check) => ({
      id: check.id,
      name: check.name,
      description: valOrUndefined(check.description),
      file: valOrUndefined(check.file),
      group: valOrUndefined(check.group),
      is_annotation: check.is_annotation,
      is_required: check.is_required,
      is_comment_required: check.is_comment_required,
      artifact: valOrUndefined(check.artifact),
      max_annotations: valOrUndefined(check.max_annotations),
      points: check.points,
      data: check.data,
      annotation_target: valOrUndefined(check.annotation_target) as "file" | "artifact" | undefined
    }));
}

function valOrUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function hydratedRubricCriteriaToYamlRubric(criteria: HydratedRubricCriteria[]): YmlRubricCriteriaType[] {
  criteria.sort((a, b) => a.ordinal - b.ordinal);
  return criteria.map((criteria) => ({
    id: criteria.id,
    data: criteria.data,
    description: valOrUndefined(criteria.description),
    is_additive: criteria.is_additive,
    name: criteria.name,
    total_points: criteria.total_points,
    max_checks_per_submission: valOrUndefined(criteria.max_checks_per_submission),
    min_checks_per_submission: valOrUndefined(criteria.min_checks_per_submission),
    checks: hydratedRubricChecksToYamlRubric(criteria.rubric_checks)
  }));
}

function hydratedRubricPartToYamlRubric(parts: HydratedRubricPart[]): YmlRubricPartType[] {
  parts.sort((a, b) => a.ordinal - b.ordinal);
  return parts.map((part) => ({
    id: part.id,
    data: valOrUndefined(part.data),
    description: valOrUndefined(part.description),
    name: part.name,
    criteria: hydratedRubricCriteriaToYamlRubric(part.rubric_criteria)
  }));
}

function HydratedRubricToYamlRubric(rubric: HydratedRubric): YmlRubricType {
  return {
    name: rubric.name,
    assignment_id: rubric.assignment_id,
    description: valOrUndefined(rubric.description),
    parts: hydratedRubricPartToYamlRubric(rubric.rubric_parts),
    is_private: rubric.is_private,
    review_round: valOrNull(rubric.review_round)
  };
}

function valOrNull<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

function YamlChecksToHydratedChecks(checks: YmlRubricChecksType[]): HydratedRubricCheck[] {
  if (!checks || checks.length === 0) {
    throw new Error("Criteria must have at least one check");
  }
  return checks.map((check, index) => ({
    id: check.id || -1,
    name: check.name,
    description: valOrNull(check.description),
    ordinal: index,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: rubricCheckDataOrThrow(check) ?? null,
    rubric_criteria_id: 0,
    file: valOrNull(check.file),
    artifact: valOrNull(check.artifact),
    group: valOrNull(null),
    is_annotation: check.is_annotation,
    is_comment_required: check.is_comment_required,
    max_annotations: valOrNull(check.max_annotations),
    points: check.points,
    is_required: check.is_required,
    annotation_target: valOrNull(check.annotation_target)
  }));
}

function YamlCriteriaToHydratedCriteria(part_id: number, criteria: YmlRubricCriteriaType[]): HydratedRubricCriteria[] {
  return criteria.map((criteria, index) => ({
    id: criteria.id || -1,
    name: criteria.name,
    description: valOrNull(criteria.description),
    ordinal: index,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: criteria.data,
    rubric_part_id: part_id,
    is_additive: criteria.is_additive || false,
    total_points: criteria.total_points || 0,
    max_checks_per_submission: valOrNull(criteria.max_checks_per_submission),
    min_checks_per_submission: valOrNull(criteria.min_checks_per_submission),
    rubric_checks: YamlChecksToHydratedChecks(criteria.checks)
  }));
}

function YamlPartsToHydratedParts(parts: YmlRubricPartType[]): HydratedRubricPart[] {
  const partsWithIds = parts.filter((part) => part.id);
  const partIds = new Set(partsWithIds.map((part) => part.id));
  if (partIds.size !== partsWithIds.length) {
    throw new Error(
      "Duplicate part ids in YAML. If you intend to copy a part, simply remove the ID on the copy, and a new ID will be generated for the new part upon saving."
    );
  }
  const criteriaWithIds = parts.flatMap((part) => part.criteria.filter((criteria) => criteria.id));
  const criteriaIds = new Set(criteriaWithIds.map((criteria) => criteria.id));
  if (criteriaIds.size !== criteriaWithIds.length) {
    throw new Error(
      "Duplicate criteria ids in YAML. If you intend to copy a criteria, simply remove the ID on the copy, and a new ID will be generated for the new criteria upon saving."
    );
  }
  const checksWithIds = parts.flatMap((part) =>
    part.criteria.flatMap((criteria) => criteria.checks.filter((check) => check.id))
  );
  const checkIds = new Set(checksWithIds.map((check) => check.id));
  if (checkIds.size !== checksWithIds.length) {
    throw new Error(
      "Duplicate check ids in YAML. If you intend to copy a check, simply remove the ID on the copy, and a new ID will be generated for the new check upon saving."
    );
  }
  return parts.map((part, index) => ({
    id: part.id || -1,
    name: part.name,
    description: valOrNull(part.description),
    ordinal: index,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: part.data,
    rubric_criteria: YamlCriteriaToHydratedCriteria(part.id || -1, part.criteria)
  }));
}

function YamlRubricToHydratedRubric(yaml: YmlRubricType): HydratedRubric {
  return {
    id: 0,
    class_id: 0,
    created_at: "",
    name: yaml.name,
    assignment_id: yaml.assignment_id,
    description: valOrNull(yaml.description),
    rubric_parts: YamlPartsToHydratedParts(yaml.parts),
    is_private: yaml.is_private,
    review_round: yaml.review_round
  };
}

function findUpdatedPropertyNames<T extends object>(newItem: T, existingItem: T): (keyof T)[] {
  return Object.keys(newItem)
    .filter(
      (key) =>
        !Array.isArray(newItem[key as keyof T]) && key !== "rubric_id" && key !== "class_id" && key !== "created_at"
    )
    .filter(
      (key) =>
        (key === "data" &&
          newItem[key as keyof T] != existingItem[key as keyof T] &&
          JSON.stringify(newItem[key as keyof T]) != JSON.stringify(existingItem[key as keyof T])) ||
        newItem[key as keyof T] != existingItem[key as keyof T]
    ) as (keyof T)[];
}

export default function RubricPage() {
  const { assignment_id } = useParams();
  const { colorMode } = useColorMode();

  const { queryResult: assignmentQueryResult } = useShow<Assignment>({
    resource: "assignments",
    id: assignment_id as string,
    meta: {
      select: "id, class_id, title"
    }
  });
  const assignmentDetails = assignmentQueryResult.data?.data;
  const isLoadingAssignment = assignmentQueryResult.isLoading;

  const [activeRubric, setActiveRubric] = useState<HydratedRubric | undefined>(undefined);
  const initialActiveRubricSnapshot = useRef<HydratedRubric | undefined>(undefined);
  const [activeReviewRound, setActiveReviewRound] = useState<HydratedRubric["review_round"]>(
    REVIEW_ROUNDS_AVAILABLE[1] // Default to 'grading-review'
  );
  const [isLoadingCurrentRubric, setIsLoadingCurrentRubric] = useState<boolean>(true);

  const [value, setValue] = useState("");
  const [rubricForSidebar, setRubricForSidebar] = useState<HydratedRubric | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [errorMarkers, setErrorMarkers] = useState<{ message: string; startLineNumber: number }[]>([]);

  const { mutateAsync: updateResource } = useUpdate({});
  const { mutateAsync: deleteResource } = useDelete({});
  const { mutateAsync: createResource } = useCreate({});
  const debounceTimeoutRef = useRef<NodeJS.Timeout>();
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [updatePaused, setUpdatePaused] = useState<boolean>(false);

  const { refetch: refetchCurrentRubric } = useList<HydratedRubric>({
    resource: "rubrics",
    filters: [
      {
        field: "assignment_id",
        operator: "eq",
        value: assignment_id as string
      },
      {
        field: "review_round",
        operator: "eq",
        value: activeReviewRound
      }
    ],
    sorters: [{ field: "id", order: "asc" }], // Should fetch at most 1
    meta: {
      select: "*, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))"
    },
    queryOptions: {
      enabled: !!assignment_id && !!activeReviewRound,
      onSuccess: (data) => {
        const rubric = data.data && data.data.length > 0 ? data.data[0] : undefined;
        setActiveRubric(rubric);
        initialActiveRubricSnapshot.current = rubric ? JSON.parse(JSON.stringify(rubric)) : undefined;
        setIsLoadingCurrentRubric(false);
        // If no rubric, editor will be empty via useEffect on activeRubric
      },
      onError: (err) => {
        toaster.error({
          title: "Error fetching rubric",
          description: (err as HttpError).message || "Could not load rubric for this review round."
        });
        setActiveRubric(undefined);
        initialActiveRubricSnapshot.current = undefined;
        setIsLoadingCurrentRubric(false);
      }
    }
  });

  const createMinimalNewHydratedRubric = useCallback(
    (
      currentAssignmentId: string,
      currentClassId: number,
      reviewRound: HydratedRubric["review_round"]
    ): HydratedRubric => {
      const roundNameProper = reviewRound
        ? reviewRound
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ")
        : "New";
      const name = `${roundNameProper} Rubric for ${assignmentDetails?.title || "Assignment"}`;

      return {
        id: 0, // Indicates it's a new, unsaved rubric template
        name: name,
        description: null,
        assignment_id: Number(currentAssignmentId),
        class_id: currentClassId,
        is_private: false,
        review_round: reviewRound,
        rubric_parts: [],
        created_at: "" // Will be set by DB
      };
    },
    [assignmentDetails?.title]
  );

  const createNewRubricTemplate = useCallback(
    (
      currentAssignmentId: string,
      currentClassId: number,
      reviewRound: HydratedRubric["review_round"]
    ): HydratedRubric => {
      const newRubricBase = YAML.parse(defaultRubric) as YmlRubricType;
      newRubricBase.assignment_id = Number(currentAssignmentId);
      newRubricBase.review_round = reviewRound;
      if (assignmentDetails?.title) {
        newRubricBase.name = `${assignmentDetails.title} - ${reviewRound
          ?.split("-")
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join(" ")} Rubric`;
      }

      const hydrated = YamlRubricToHydratedRubric(newRubricBase);
      hydrated.id = 0; // New template, not saved yet
      hydrated.class_id = currentClassId;
      hydrated.assignment_id = Number(currentAssignmentId);
      hydrated.review_round = reviewRound;

      hydrated.rubric_parts.forEach((part, pIdx) => {
        part.id = -(pIdx + 1); // Negative IDs for new items not yet in DB
        part.class_id = currentClassId;
        part.rubric_id = 0; // Will be set upon saving the main rubric
        part.rubric_criteria.forEach((criteria, cIdx) => {
          criteria.id = -(cIdx + 1 + pIdx * 100);
          criteria.class_id = currentClassId;
          criteria.rubric_id = 0;
          criteria.rubric_part_id = part.id;
          criteria.rubric_checks.forEach((check, chIdx) => {
            check.id = -(chIdx + 1 + cIdx * 1000 + pIdx * 100000);
            check.class_id = currentClassId;
            check.rubric_criteria_id = criteria.id;
          });
        });
      });
      return hydrated;
    },
    [assignmentDetails?.title]
  );

  const handleReviewRoundChange = useCallback(
    (newReviewRound: HydratedRubric["review_round"]) => {
      if (!assignmentDetails || !assignment_id) return;
      setIsLoadingCurrentRubric(true);
      setActiveReviewRound(newReviewRound);
      // The useList hook will automatically refetch due to activeReviewRound dependency change.
      // Its onSuccess/onError will handle setting activeRubric and snapshot.
    },
    [assignmentDetails, assignment_id]
  );

  function handleEditorWillMount(monaco: Monaco) {
    window.MonacoEnvironment = {
      getWorker(_module_id, label) {
        switch (label) {
          case "editorWorkerService":
            return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url));
          case "yaml":
            return new Worker(new URL("monaco-yaml/yaml.worker", import.meta.url));
          default:
            throw new Error(`Unknown label ${label}`);
        }
      }
    };

    configureMonacoYaml(monaco, {
      enableSchemaRequest: true,
      schemas: [
        {
          fileMatch: ["*"],
          uri: "/RubricSchema.json"
        }
      ]
    });
  }

  const debouncedParseYaml = useCallback(
    (yamlValue: string) => {
      if (errorMarkers.length === 0 && assignmentDetails && activeReviewRound) {
        try {
          const parsed = YAML.parse(yamlValue) as YmlRubricType;
          const hydratedFromYaml = YamlRubricToHydratedRubric(parsed);

          // Ensure the parsed rubric aligns with the current context (assignment, class, review round)
          // especially if it's a new rubric being defined in the editor.
          const mergedRubric: HydratedRubric = {
            ...(activeRubric ||
              createMinimalNewHydratedRubric(assignment_id as string, assignmentDetails.class_id, activeReviewRound)), // Base on activeRubric or a new minimal if active is undefined
            name: hydratedFromYaml.name,
            description: hydratedFromYaml.description,
            is_private: hydratedFromYaml.is_private,
            review_round: activeReviewRound, // Always force to current tab's review round
            rubric_parts: hydratedFromYaml.rubric_parts,
            // Preserve ID if editing an existing rubric, otherwise it's 0 or negative from template
            id: activeRubric && activeRubric.id > 0 ? activeRubric.id : 0,
            assignment_id: Number(assignment_id),
            class_id: assignmentDetails.class_id
          };

          setRubricForSidebar(mergedRubric);
          setError(undefined);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Unknown YAML parsing error");
        }
      }
    },
    [
      errorMarkers.length,
      activeRubric,
      assignmentDetails,
      assignment_id,
      activeReviewRound,
      createMinimalNewHydratedRubric
    ]
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value) {
        setValue(value);
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }
        setUpdatePaused(true);
        debounceTimeoutRef.current = setTimeout(() => {
          debouncedParseYaml(value);
          setUpdatePaused(false);
        }, 2000);
      }
    },
    [debouncedParseYaml]
  );

  useEffect(() => {
    if (activeRubric) {
      const yamlString = YAML.stringify(HydratedRubricToYamlRubric(activeRubric));
      setValue(yamlString);
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
      // Directly parse and set for sidebar to reflect the authoritative activeRubric
      debouncedParseYaml(yamlString);
      setUpdatePaused(false);
    } else {
      setValue(""); // Clear editor if no active rubric
      setRubricForSidebar(undefined);
    }
  }, [activeRubric, debouncedParseYaml]);

  const updatePartIfChanged = useCallback(
    async (part: HydratedRubricPart, existingPart: HydratedRubricPart) => {
      if (part.id !== existingPart.id) {
        return { toCreate: [], toUpdate: [], toDelete: [] };
      }
      const updatedPropertyNames = findUpdatedPropertyNames(part, existingPart);
      if (updatedPropertyNames.length === 0) {
        return;
      }
      const values = updatedPropertyNames.reduce(
        (acc, curr) => ({
          ...acc,
          [curr]: part[curr]
        }),
        {}
      );
      await updateResource({
        id: part.id,
        resource: "rubric_parts",
        values
      });
    },
    [updateResource]
  );
  const updateCriteriaIfChanged = useCallback(
    async (criteria: HydratedRubricCriteria, existingCriteria: HydratedRubricCriteria) => {
      if (criteria.id !== existingCriteria.id) {
        return { toCreate: [], toUpdate: [], toDelete: [] };
      }
      const updatedPropertyNames = findUpdatedPropertyNames(criteria, existingCriteria);
      if (updatedPropertyNames.length === 0) {
        return;
      }
      const values = updatedPropertyNames.reduce(
        (acc, curr) => ({
          ...acc,
          [curr]: criteria[curr]
        }),
        {}
      );
      await updateResource({
        id: criteria.id,
        resource: "rubric_criteria",
        values
      });
    },
    [updateResource]
  );
  const updateCheckIfChanged = useCallback(
    async (check: HydratedRubricCheck, existingCheck: HydratedRubricCheck) => {
      if (check.id !== existingCheck.id) {
        return { toCreate: [], toUpdate: [], toDelete: [] };
      }
      const updatedPropertyNames = findUpdatedPropertyNames(check, existingCheck);
      if (updatedPropertyNames.length === 0) {
        return;
      }
      const values = updatedPropertyNames.reduce(
        (acc, curr) => ({
          ...acc,
          [curr]: check[curr]
        }),
        {}
      );
      await updateResource({
        id: check.id,
        resource: "rubric_checks",
        values
      });
    },
    [updateResource]
  );
  const saveRubric = useCallback(
    async (yamlStringValue: string) => {
      if (!assignmentDetails || !activeReviewRound) {
        // activeRubric might be undefined if creating new
        toaster.create({
          title: "Error",
          description: "Cannot save: Missing assignment details or active review round.",
          type: "error"
        });
        return;
      }

      let parsedRubricFromEditor: HydratedRubric;
      try {
        parsedRubricFromEditor = YamlRubricToHydratedRubric(YAML.parse(yamlStringValue));
        // Ensure critical fields are aligned with current context
        parsedRubricFromEditor.assignment_id = Number(assignment_id);
        parsedRubricFromEditor.class_id = assignmentDetails.class_id;
        parsedRubricFromEditor.review_round = activeReviewRound;
      } catch (e) {
        toaster.error({ title: "YAML Error", description: `Invalid YAML: ${(e as Error).message}` });
        setIsSaving(false);
        return;
      }

      let currentEffectiveRubricId = initialActiveRubricSnapshot.current?.id || 0;
      let isNewRubricCreationFlow = !initialActiveRubricSnapshot.current || initialActiveRubricSnapshot.current.id <= 0;

      // Baseline for diffing is the state when the tab was loaded/last saved, or a minimal new rubric if starting fresh on this tab.
      const baselineRubricForDiff: HydratedRubric =
        initialActiveRubricSnapshot.current ||
        createMinimalNewHydratedRubric(assignment_id as string, assignmentDetails.class_id, activeReviewRound);

      // If snapshot existed but ID was 0 (e.g. loaded demo but not saved), it's still a creation.
      if (initialActiveRubricSnapshot.current && initialActiveRubricSnapshot.current.id <= 0) {
        isNewRubricCreationFlow = true;
      }

      if (isNewRubricCreationFlow) {
        const newRubricPayload: Omit<HydratedRubric, "id" | "created_at" | "class_id" | "rubric_parts"> & {
          class_id: number;
          assignment_id: number;
        } = {
          name: parsedRubricFromEditor.name,
          description: parsedRubricFromEditor.description,
          assignment_id: Number(assignment_id),
          class_id: assignmentDetails.class_id,
          is_private: parsedRubricFromEditor.is_private,
          review_round: activeReviewRound
        };
        try {
          const createdTopLevelRubric = await createResource({
            resource: "rubrics",
            values: newRubricPayload
          });
          currentEffectiveRubricId = createdTopLevelRubric.data.id as number;
          if (!currentEffectiveRubricId) throw new Error("Failed to create rubric shell.");

          // Update the editor's parsed rubric with the new ID for sub-item creation
          parsedRubricFromEditor.id = currentEffectiveRubricId;
        } catch (e) {
          toaster.create({ title: "Error Creating Rubric", description: (e as Error).message, type: "error" });
          setIsSaving(false);
          return;
        }
      } else {
        // This is an update to an existing rubric (currentEffectiveRubricId > 0)
        const topLevelRubricChanges: Partial<HydratedRubric> = {};
        if (parsedRubricFromEditor.name !== baselineRubricForDiff.name)
          topLevelRubricChanges.name = parsedRubricFromEditor.name;
        if (parsedRubricFromEditor.description !== baselineRubricForDiff.description)
          topLevelRubricChanges.description = parsedRubricFromEditor.description;
        if (parsedRubricFromEditor.is_private !== baselineRubricForDiff.is_private)
          topLevelRubricChanges.is_private = parsedRubricFromEditor.is_private;
        // review_round should not change via editor for an existing rubric, it's tab-driven.
        // But if somehow it's different in parsed (e.g. user manually edited it in YAML),
        // we should probably stick to activeReviewRound or log a warning.
        // For now, we assume activeReviewRound is the source of truth for the save.
        if (baselineRubricForDiff.review_round !== activeReviewRound) {
          // This case should ideally not happen if UI enforces activeReviewRound
          topLevelRubricChanges.review_round = activeReviewRound;
        }

        if (Object.keys(topLevelRubricChanges).length > 0) {
          await updateResource({
            id: currentEffectiveRubricId,
            resource: "rubrics",
            values: topLevelRubricChanges
          });
        }
      }

      // Ensure all parts, criteria, and checks in the parsedRubricFromEditor
      // have the correct rubric_id, class_id before diffing and creating/updating.
      // This is crucial especially for new rubrics where sub-items get the parent ID.
      parsedRubricFromEditor.rubric_parts.forEach((part) => {
        part.rubric_id = currentEffectiveRubricId;
        part.class_id = assignmentDetails.class_id;
        part.rubric_criteria.forEach((criteria) => {
          criteria.rubric_id = currentEffectiveRubricId;
          criteria.class_id = assignmentDetails.class_id;
          // parent part ID will be set during creation/update loop
          criteria.rubric_checks.forEach((check) => {
            // check.rubric_id = currentEffectiveRubricId; // Checks don't have direct rubric_id
            check.class_id = assignmentDetails.class_id;
            // parent criteria ID will be set during creation/update loop
          });
        });
      });

      const partsToCompareAgainst = baselineRubricForDiff.rubric_parts;
      const partChanges = findChanges(parsedRubricFromEditor.rubric_parts, partsToCompareAgainst);

      // For new criteria/checks, their parent IDs (rubric_part_id, rubric_criteria_id)
      // might be negative if they came from a template. We need to update these
      // to the actual DB IDs of their parents *after* the parents are created.

      // --- Deletions first (bottom-up to avoid foreign key issues if possible, though cascade should handle) ---
      const allNewCriteriaFromEditor = parsedRubricFromEditor.rubric_parts.flatMap((part) => part.rubric_criteria);
      const checksToCompareAgainst = baselineRubricForDiff.rubric_parts.flatMap((part) =>
        part.rubric_criteria.flatMap((c) => c.rubric_checks)
      );
      const allNewChecksFromEditor = allNewCriteriaFromEditor.flatMap(
        (criteria: HydratedRubricCriteria) => criteria.rubric_checks
      );
      const checkChanges = findChanges(allNewChecksFromEditor, checksToCompareAgainst);

      await Promise.all(checkChanges.toDelete.map((id: number) => deleteResource({ id, resource: "rubric_checks" })));

      const criteriaToCompareAgainst = baselineRubricForDiff.rubric_parts.flatMap((part) => part.rubric_criteria);
      const criteriaChanges = findChanges(allNewCriteriaFromEditor, criteriaToCompareAgainst);

      await Promise.all(
        criteriaChanges.toDelete.map((id: number) => deleteResource({ id, resource: "rubric_criteria" }))
      );

      await Promise.all(partChanges.toDelete.map((id: number) => deleteResource({ id, resource: "rubric_parts" })));

      // --- Creations and Updates (top-down: Parts -> Criteria -> Checks) ---

      // Parts
      for (const partData of partChanges.toCreate) {
        const partCopy: Omit<HydratedRubricPart, "id" | "created_at" | "rubric_criteria"> = {
          name: partData.name,
          description: partData.description,
          ordinal: partData.ordinal,
          data: partData.data,
          class_id: assignmentDetails.class_id,
          rubric_id: currentEffectiveRubricId
        };
        const createdPart = await createResource({ resource: "rubric_parts", values: partCopy });
        if (!createdPart.data.id) throw new Error("Failed to create part");
        // Update the ID in the parsedRubricFromEditor for subsequent children
        const editorPart = parsedRubricFromEditor.rubric_parts.find(
          (p) => p.id === partData.id || (p.name === partData.name && p.ordinal === partData.ordinal)
        );
        if (editorPart) editorPart.id = createdPart.data.id as number;
      }
      await Promise.all(
        partChanges.toUpdate.map((part: HydratedRubricPart) =>
          updatePartIfChanged(
            part,
            baselineRubricForDiff.rubric_parts.find((p) => p.id === part.id) as HydratedRubricPart
          )
        )
      );

      // Update rubric_part_id for all criteria in parsedRubricFromEditor based on potentially new part IDs
      parsedRubricFromEditor.rubric_parts.forEach((part) => {
        part.rubric_criteria.forEach((criteria) => {
          if (part.id && part.id > 0) {
            // Ensure part has a DB ID
            criteria.rubric_part_id = part.id;
          } else {
            // This implies an issue, a criteria's parent part from editor doesn't have a DB ID.
            // Try to find by name/ordinal if it was a new part that just got an ID.
            const matchedNewPart = parsedRubricFromEditor.rubric_parts.find(
              (p) => p.name === part.name && p.ordinal === part.ordinal && p.id && p.id > 0
            );
            if (matchedNewPart && matchedNewPart.id) {
              criteria.rubric_part_id = matchedNewPart.id;
            } else {
              throw new Error(
                `Cannot save criteria '${criteria.name}': Its parent part does not have a valid database ID.`
              );
            }
          }
        });
      });

      // Criteria (re-calculate allNewCriteriaFromEditor as IDs might have changed)
      const finalAllNewCriteriaFromEditor = parsedRubricFromEditor.rubric_parts.flatMap((part) => part.rubric_criteria);
      const finalCriteriaChanges = findChanges(finalAllNewCriteriaFromEditor, criteriaToCompareAgainst); // Re-diff if necessary, or just use create/update lists

      for (const criteriaData of finalCriteriaChanges.toCreate) {
        if (!criteriaData.rubric_part_id || criteriaData.rubric_part_id <= 0) {
          throw new Error(`Cannot create criteria '${criteriaData.name}': Missing or invalid parent part ID.`);
        }
        const criteriaCopy: Omit<HydratedRubricCriteria, "id" | "created_at" | "rubric_checks"> = {
          name: criteriaData.name,
          description: criteriaData.description,
          ordinal: criteriaData.ordinal,
          data: criteriaData.data,
          is_additive: criteriaData.is_additive,
          total_points: criteriaData.total_points,
          max_checks_per_submission: criteriaData.max_checks_per_submission,
          min_checks_per_submission: criteriaData.min_checks_per_submission,
          class_id: assignmentDetails.class_id,
          rubric_id: currentEffectiveRubricId,
          rubric_part_id: criteriaData.rubric_part_id
        };
        const createdCriteria = await createResource({ resource: "rubric_criteria", values: criteriaCopy });
        if (!createdCriteria.data.id) throw new Error("Failed to create criteria");
        const editorCriteria = finalAllNewCriteriaFromEditor.find(
          (c) =>
            c.id === criteriaData.id ||
            (c.name === criteriaData.name &&
              c.ordinal === criteriaData.ordinal &&
              c.rubric_part_id === criteriaData.rubric_part_id)
        );
        if (editorCriteria) editorCriteria.id = createdCriteria.data.id as number;
      }
      await Promise.all(
        finalCriteriaChanges.toUpdate.map((criteria: HydratedRubricCriteria) => {
          const existingCrit = criteriaToCompareAgainst.find((c) => c.id === criteria.id);
          if (existingCrit) return updateCriteriaIfChanged(criteria, existingCrit);
          return Promise.resolve();
        })
      );

      // Update rubric_criteria_id for all checks
      finalAllNewCriteriaFromEditor.forEach((criteria) => {
        criteria.rubric_checks.forEach((check) => {
          if (criteria.id && criteria.id > 0) {
            // Ensure criteria has a DB ID
            check.rubric_criteria_id = criteria.id;
          } else {
            const matchedNewCriteria = finalAllNewCriteriaFromEditor.find(
              (c) =>
                c.name === criteria.name &&
                c.ordinal === criteria.ordinal &&
                c.rubric_part_id === criteria.rubric_part_id &&
                c.id &&
                c.id > 0
            );
            if (matchedNewCriteria && matchedNewCriteria.id) {
              check.rubric_criteria_id = matchedNewCriteria.id;
            } else {
              throw new Error(
                `Cannot save check '${check.name}': Its parent criteria does not have a valid database ID.`
              );
            }
          }
        });
      });

      // Checks (re-calculate allNewChecksFromEditor)
      const finalAllNewChecksFromEditor = finalAllNewCriteriaFromEditor.flatMap((c) => c.rubric_checks);
      const finalCheckChanges = findChanges(finalAllNewChecksFromEditor, checksToCompareAgainst);

      for (const checkData of finalCheckChanges.toCreate) {
        if (!checkData.rubric_criteria_id || checkData.rubric_criteria_id <= 0) {
          throw new Error(`Cannot create check '${checkData.name}': Missing or invalid parent criteria ID.`);
        }
        const checkCopy: Omit<HydratedRubricCheck, "id" | "created_at"> = {
          // rubric_id is not on checks table
          name: checkData.name,
          description: checkData.description,
          ordinal: checkData.ordinal,
          data: checkData.data,
          file: checkData.file,
          artifact: checkData.artifact,
          group: checkData.group,
          is_annotation: checkData.is_annotation,
          is_comment_required: checkData.is_comment_required,
          max_annotations: checkData.max_annotations,
          points: checkData.points,
          is_required: checkData.is_required,
          annotation_target: checkData.annotation_target,
          class_id: assignmentDetails.class_id,
          rubric_criteria_id: checkData.rubric_criteria_id
        };
        const createdCheck = await createResource({ resource: "rubric_checks", values: checkCopy });
        if (!createdCheck.data.id) throw new Error("Failed to create check");
        checkData.id = createdCheck.data.id as number; // Update ID in the source array (if needed elsewhere, though usually not)
      }
      await Promise.all(
        finalCheckChanges.toUpdate.map((check: HydratedRubricCheck) => {
          const existingChk = checksToCompareAgainst.find((ch) => ch.id === check.id);
          if (existingChk) return updateCheckIfChanged(check, existingChk);
          return Promise.resolve();
        })
      );

      // After all operations, refetch the current rubric to update activeRubric and snapshot
      // This ensures the UI has the very latest state from DB, including all generated IDs and timestamps.
      await refetchCurrentRubric();
    },
    [
      assignmentDetails,
      activeReviewRound,
      createResource,
      updateResource,
      deleteResource,
      assignment_id,
      updatePartIfChanged,
      updateCriteriaIfChanged,
      updateCheckIfChanged,
      refetchCurrentRubric, // Added refetchCurrentRubric
      createMinimalNewHydratedRubric
    ]
  );

  if (isLoadingAssignment || (!activeRubric && isLoadingCurrentRubric && !initialActiveRubricSnapshot.current)) {
    // Adjust loading condition
    return (
      <Center h="100vh">
        <Spinner size="xl" />
      </Center>
    );
  }

  if (!assignmentDetails) {
    return <Alert status="error">Assignment not found.</Alert>;
  }

  return (
    <Flex w="100%" minW="0" direction="column">
      <HStack w="100%" mt={2} mb={2} justifyContent="space-between" pr={2}>
        <Toaster />
        <HStack>
          <Heading size="md">
            {assignmentDetails?.title ? `${assignmentDetails.title}: ` : ""}Handgrading Rubric
          </Heading>
          <Button
            variant="solid"
            onClick={() => {
              if (assignmentDetails && activeReviewRound) {
                const demoTemplate = createNewRubricTemplate(
                  assignment_id as string,
                  assignmentDetails.class_id,
                  activeReviewRound
                );
                setActiveRubric(demoTemplate); // This will trigger useEffect to update editor value
                initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(demoTemplate)); // Set snapshot to the demo
                setRubricForSidebar(demoTemplate); // Update sidebar preview immediately
                toaster.success({
                  title: "Demo Loaded",
                  description: "Demo rubric is loaded in the editor. Save to persist."
                });
              }
            }}
          >
            Load Demo Rubric
          </Button>
        </HStack>
        <HStack>
          <Button
            variant="ghost"
            colorPalette="red"
            onClick={() => {
              // Reset to the state when the tab was loaded or last saved/demo loaded
              if (initialActiveRubricSnapshot.current) {
                setActiveRubric(JSON.parse(JSON.stringify(initialActiveRubricSnapshot.current)));
                toaster.create({
                  title: "Reset",
                  description: "Editor reset to last saved state for this tab.",
                  type: "info"
                });
              } else {
                // If no snapshot (e.g., tab was empty and never had a demo loaded)
                // Create a minimal new one or just clear. For now, clear.
                // Or, better, if there's an activeReviewRound, create a minimal new for that.
                if (assignmentDetails && activeReviewRound) {
                  const minimal = createMinimalNewHydratedRubric(
                    assignment_id as string,
                    assignmentDetails.class_id,
                    activeReviewRound
                  );
                  setActiveRubric(minimal);
                  initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(minimal)); // Treat this minimal as the new "snapshot"
                } else {
                  setActiveRubric(undefined); // This will clear the editor via useEffect
                  initialActiveRubricSnapshot.current = undefined;
                }
                toaster.create({
                  title: "Reset",
                  description: "Editor reset to an empty state for this tab.",
                  type: "info"
                });
              }
            }}
          >
            Reset
          </Button>
          <Button
            colorPalette="green"
            loadingText="Saving..."
            loading={isSaving}
            onClick={async () => {
              try {
                setIsSaving(true);
                await saveRubric(value); // saveRubric now internally calls refetchCurrentRubric
                toaster.success({
                  title: "Rubric Saved",
                  description: "The rubric has been saved successfully."
                });
                // No need to manually refetch and setActiveRubric here, saveRubric handles it.
              } catch (error) {
                // Error handling for saveRubric promise rejection (e.g. from deeper errors not caught by toaster in saveRubric itself)
                if (error instanceof Error) {
                  toaster.error({
                    title: "Failed to save rubric",
                    description: `An unexpected error occurred: ${error.message}`
                  });
                } else {
                  toaster.error({
                    title: "Failed to save rubric",
                    description: "An unknown error occurred during the save process."
                  });
                }
              } finally {
                setIsSaving(false);
              }
            }}
          >
            Save
          </Button>
        </HStack>
      </HStack>
      <Tabs.Root
        value={activeReviewRound || REVIEW_ROUNDS_AVAILABLE[0]} // Ensure a value is always provided
        onValueChange={(details) => {
          if (details.value) {
            // Ensure details.value is not null/undefined
            handleReviewRoundChange(details.value as HydratedRubric["review_round"]);
          }
        }}
        lazyMount
        unmountOnExit // This might cause issues with Monaco state if not handled carefully, but let's keep for now.
        mb={2}
      >
        <Tabs.List>
          {REVIEW_ROUNDS_AVAILABLE.map((rr) => (
            <Tabs.Trigger key={rr || "undefined_round"} value={rr || "undefined_round_val"}>
              {" "}
              {/* Ensure value is unique and defined */}
              {rr
                ? rr
                    .split("-")
                    .map((w) => w[0].toUpperCase() + w.slice(1))
                    .join(" ")
                : "Select Round"}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>
      <Flex w="100%" minW="0" flexGrow={1}>
        <Box w="100%" minW="0">
          <VStack w="100%" h="100%">
            {isLoadingCurrentRubric && !activeRubric && (
              <Center height="calc(100vh - 150px)" width="100%">
                <Spinner size="xl" />
              </Center>
            )}
            {(!isLoadingCurrentRubric || activeRubric) && (
              <Editor
                height="calc(100vh - 150px)"
                width="100%"
                defaultLanguage="yaml"
                path={`rubric-${activeReviewRound || "new"}.yml`}
                beforeMount={handleEditorWillMount}
                value={value} // Value from state
                theme={colorMode === "dark" ? "vs-dark" : "vs"}
                onValidate={(markers) => {
                  if (markers.length > 0) {
                    setError("YAML syntax error. Please fix the errors in the editor.");
                    setErrorMarkers(markers.map((m) => ({ message: m.message, startLineNumber: m.startLineNumber })));
                  } else {
                    setError(undefined);
                    setErrorMarkers([]);
                  }
                }}
                onChange={handleEditorChange}
              />
            )}
          </VStack>
        </Box>
        <Box w="lg" position="relative" h="calc(100vh - 100px)" overflowY="auto">
          {updatePaused && <Alert variant="surface">Preview paused while typing</Alert>}

          {isLoadingCurrentRubric && !rubricForSidebar && (
            <Center h="100%">
              {" "}
              <Spinner />{" "}
            </Center>
          )}

          {!isLoadingCurrentRubric && !error && !rubricForSidebar && activeReviewRound && (
            <Center h="100%">
              <VStack>
                <Text>No rubric configured for {activeReviewRound}.</Text>
                <Text fontSize="sm">You can load a demo or start typing.</Text>
              </VStack>
            </Center>
          )}

          {!error && rubricForSidebar && <RubricSidebar initialRubric={rubricForSidebar} />}
          {error && (
            <Box
              position="absolute"
              top="0"
              left="0"
              width="100%"
              height="100%"
              backgroundColor="bg.surface"
              p={4}
              display="flex"
              flexDirection="column"
              zIndex="1"
            >
              <Heading size="sm" color="fg.error" mb={2}>
                YAML Error
              </Heading>
              <Text color="fg.error" mb={2}>
                {error}
              </Text>
              {errorMarkers.length > 0 && (
                <List.Root>
                  {errorMarkers.map((marker, index) => (
                    <List.Item key={index}>
                      <Text color="fg.error" fontSize="sm">
                        Line {marker.startLineNumber}: {marker.message}
                      </Text>
                    </List.Item>
                  ))}
                </List.Root>
              )}
            </Box>
          )}
        </Box>
      </Flex>
    </Flex>
  );
}

const defaultRubric = `
name: Demo Rubric
description: Edit or delete this rubric to create your own.
parts:
  - description: >
      We might even include a complete description of the part of the assignment
      here, you get markdown, you even get $\LaTeX$ basically everywhere!
    name: Question 1
    criteria:
      - description: Overall conformance to our course [style
          guide](https://neu-se.github.io/CS4530-Spring-2024/policies/style/).
          All of these checks happen to be "annotations," which means they are
          applied directly to line(s) of code. Scoring is **negative** which
          means each check deducts points from the total points for this
          criteria.
        is_additive: false
        name: Design rules
        total_points: 15
        checks:
          - name: Non-compliant name
            description: All new names (e.g. for local variables, methods, and properties)
              follow the naming conventions defined in our style guide (Max 6
              annotations per-submission, comment required)
            is_annotation: true
            is_required: false
            is_comment_required: true
            max_annotations: 6
            points: 2
          - name: Missing documentation
            description: Max 10 annotations per-submission. Comment optional.
            is_annotation: true
            is_required: false
            is_comment_required: false
            max_annotations: 10
            points: 2
      - description: This is an example of a criteria that has multiple checks, and only
          one can be selected.
        is_additive: true
        name: Overall design quality
        total_points: 10
        max_checks_per_submission: 1
        min_checks_per_submission: 1
        checks:
          - name: It's the best
            description: This is *great* and has low coupling and high cohesion, something
              something objects.
            is_annotation: false
            is_required: false
            is_comment_required: false
            max_annotations: 1
            points: 10
          - name: It's mediocre
            description: Something's not quite right, the grader has added comments to
              explain
            is_annotation: false
            is_required: false
            is_comment_required: true
            max_annotations: 1
            points: 5
      - description: This is additive scoring with multiple checks. Each check has
          multiple options. Graders must select one option for each check.
        is_additive: true
        name: Test case quality
        total_points: 10
        checks:
          - name: Submission-level check, select one option
            description: This check demonstrates having an "option". The grader selects the
              option from this sidebar. This check is required.
            file: src/test/java/com/pawtograder/example/java/EntrypointTest.java
            is_annotation: false
            is_required: true
            is_comment_required: false
            points: 4
            data:
              options:
                - label: Satisfactory
                  points: 10
                - label: Marginal
                  points: 5
                - label: Unacceptable
                  points: 0
          - name: File-level check, select one option
            description: This check demonstrates having an "option". The grader selects the
              option by marking a line. This check is required.
            file: src/test/java/com/pawtograder/example/java/EntrypointTest.java
            is_annotation: true
            is_required: true
            is_comment_required: false
            max_annotations: 1
            points: 4
            data:
              options:
                - label: Satisfactory
                  points: 10
                - label: Marginal
                  points: 5
                - label: Unacceptable
                  points: 0
  - name: Part 2
    description: This is another part/question. You might assign grading per-part,
      and we'll track what's been done and what hasn't.
    criteria:
      - name: A big criteria with checkboxes, positive scoring
        description: Some use-cases might call for having graders tick boxes to add
          points. This will require at least 2 and at most 4 boxes to be ticked.
        is_additive: true
        total_points: 10
        max_checks_per_submission: 4
        min_checks_per_submission: 2
        checks:
          - name: Some option 1
            description: This might be useful for $O(n^2)$ having more details describing
              the attribute
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 2
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 3
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 4
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 5
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 6
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
      - description: Some use-cases might call for having graders tick boxes to deduct
          points. This will require at least 2 and at most 4 boxes to be ticked.
        is_additive: false
        name: A big criteria with checkboxes, NEGATIVE scoring
        total_points: 10
        max_checks_per_submission: 4
        min_checks_per_submission: 2
        checks:
          - name: Some option 1
            description: This might be useful for $O(n^2)$ having more details describing
              the attribute
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 2
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 3
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 4
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 5
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 6
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
is_private: false
`;
