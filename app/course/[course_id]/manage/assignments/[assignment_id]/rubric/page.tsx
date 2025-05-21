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
import { Box, Button, Flex, Heading, HStack, List, Text, VStack, Tabs, Spinner, Center } from "@chakra-ui/react";
import Editor, { Monaco } from "@monaco-editor/react";
import { useCreate, useDelete, useList, useShow, useUpdate } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
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
  if (check.data.options?.length === 1) {
    throw new Error("Checks may not have only one option - they must have at least two options, or can have none");
  }
  for (const option of check.data.options) {
    if (option.points === undefined || option.points === null) {
      throw new Error("Option points are required");
    }
    if (!option.label) {
      throw new Error("Option label is required");
    }
  }
  return check.data as RubricChecksDataType;
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
      data: valOrUndefined(check.data),
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
    data: valOrUndefined(criteria.data),
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
    data: rubricCheckDataOrThrow(check),
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

  const {
    data: allRubricsForAssignmentData,
    isLoading: isLoadingRubrics,
    refetch: refetchAllRubrics
  } = useList<HydratedRubric>({
    resource: "rubrics",
    filters: [
      {
        field: "assignment_id",
        operator: "eq",
        value: assignment_id as string
      }
    ],
    sorters: [{ field: "id", order: "asc" }],
    meta: {
      select: "*, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))"
    },
    queryOptions: {
      enabled: !!assignment_id
    }
  });
  const allRubricsForAssignment = useMemo(
    () => allRubricsForAssignmentData?.data || [],
    [allRubricsForAssignmentData?.data]
  );

  const [activeRubric, setActiveRubric] = useState<HydratedRubric | undefined>(undefined);
  const initialActiveRubricSnapshot = useRef<HydratedRubric | undefined>(undefined);
  const [activeReviewRound, setActiveReviewRound] = useState<HydratedRubric["review_round"] | undefined>(undefined);

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
      const name = `${roundNameProper} Rubric`;

      return {
        id: 0,
        name: name,
        description: null,
        assignment_id: Number(currentAssignmentId),
        class_id: currentClassId,
        is_private: false,
        review_round: reviewRound,
        rubric_parts: [],
        created_at: ""
      };
    },
    []
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

      const hydrated = YamlRubricToHydratedRubric(newRubricBase);
      hydrated.id = 0;
      hydrated.class_id = currentClassId;
      hydrated.assignment_id = Number(currentAssignmentId);

      hydrated.rubric_parts.forEach((part, pIdx) => {
        part.id = -(pIdx + 1);
        part.class_id = currentClassId;
        part.rubric_id = 0;
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
    []
  );

  const handleReviewRoundChange = useCallback(
    (reviewRound: HydratedRubric["review_round"]) => {
      if (!assignmentDetails || !assignment_id) return;

      setActiveReviewRound(reviewRound);
      const existing = allRubricsForAssignment.find((r: HydratedRubric) => r.review_round === reviewRound);
      if (existing) {
        setActiveRubric(existing);
        initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(existing));
      } else {
        const newTemplate = createMinimalNewHydratedRubric(
          assignment_id as string,
          assignmentDetails.class_id,
          reviewRound
        );
        setActiveRubric(newTemplate);
        initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(newTemplate));
      }
    },
    [allRubricsForAssignment, assignmentDetails, assignment_id, createMinimalNewHydratedRubric]
  );

  useEffect(() => {
    if (allRubricsForAssignment.length > 0 && !activeRubric && assignmentDetails) {
      const gradingReviewRubric = allRubricsForAssignment.find(
        (r: HydratedRubric) => r.review_round === "grading-review"
      );
      if (gradingReviewRubric) {
        handleReviewRoundChange("grading-review");
      } else if (allRubricsForAssignment[0].review_round) {
        handleReviewRoundChange(allRubricsForAssignment[0].review_round);
      }
    } else if (
      allRubricsForAssignment.length === 0 &&
      !activeRubric &&
      assignmentDetails &&
      REVIEW_ROUNDS_AVAILABLE[1]
    ) {
      handleReviewRoundChange(REVIEW_ROUNDS_AVAILABLE[1]);
    }
  }, [allRubricsForAssignment, activeRubric, assignmentDetails, handleReviewRoundChange]);

  function handleEditorWillMount(monaco: Monaco) {
    window.MonacoEnvironment = {
      getWorker(label) {
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
      if (errorMarkers.length === 0) {
        try {
          const parsed = YAML.parse(yamlValue) as YmlRubricType;
          if (activeRubric) {
            const hydratedFromYaml = YamlRubricToHydratedRubric(parsed);
            const currentReviewRound =
              activeRubric.id === 0 && activeReviewRound ? activeReviewRound : hydratedFromYaml.review_round;

            if (!currentReviewRound && activeRubric.id === 0) {
              toaster.error({
                title: "Error",
                description: "activeReviewRound is not set for a new rubric."
              });
              setError("Cannot process YAML: Review round is missing for new rubric.");
              return;
            }

            const mergedRubric: HydratedRubric = {
              ...activeRubric,
              name: hydratedFromYaml.name,
              description: hydratedFromYaml.description,
              is_private: hydratedFromYaml.is_private,
              review_round: currentReviewRound,
              rubric_parts: hydratedFromYaml.rubric_parts
            };
            if (activeRubric.id !== 0) mergedRubric.id = activeRubric.id;
            mergedRubric.assignment_id = activeRubric.assignment_id;
            mergedRubric.class_id = activeRubric.class_id;

            setRubricForSidebar(mergedRubric);
          } else {
            setRubricForSidebar(YamlRubricToHydratedRubric(YAML.parse(yamlValue)));
          }
          setError(undefined);
        } catch (error) {
          setError(error instanceof Error ? error.message : "Unknown error");
        }
      }
    },
    [errorMarkers.length, activeRubric, activeReviewRound]
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
      setValue(YAML.stringify(HydratedRubricToYamlRubric(activeRubric)));
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
      debouncedParseYaml(YAML.stringify(HydratedRubricToYamlRubric(activeRubric)));
      setUpdatePaused(false);
    } else {
      setValue("");
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
      if (!activeRubric || !assignmentDetails || !activeReviewRound || !initialActiveRubricSnapshot.current) {
        toaster.create({
          title: "Error",
          description: "Cannot save: Missing active rubric, assignment details, review round, or initial snapshot.",
          type: "error"
        });
        return;
      }

      const parsedRubricFromEditor = YamlRubricToHydratedRubric(YAML.parse(yamlStringValue));

      let currentEffectiveRubricId = 0;
      let isNewRubricCreationFlow = false;
      let baselineRubricForDiff: HydratedRubric;

      const dbRubricForThisRound = allRubricsForAssignment.find(
        (r: HydratedRubric) => r.review_round === activeReviewRound
      );

      if (initialActiveRubricSnapshot.current && initialActiveRubricSnapshot.current.id > 0) {
        currentEffectiveRubricId = initialActiveRubricSnapshot.current.id;
        isNewRubricCreationFlow = false;
        baselineRubricForDiff = initialActiveRubricSnapshot.current;
      } else if (dbRubricForThisRound) {
        currentEffectiveRubricId = dbRubricForThisRound.id;
        isNewRubricCreationFlow = false;
        baselineRubricForDiff = dbRubricForThisRound;
        if (initialActiveRubricSnapshot.current && initialActiveRubricSnapshot.current.id <= 0) {
          const updatedActiveFromDb = {
            ...dbRubricForThisRound,
            name: parsedRubricFromEditor.name,
            description: parsedRubricFromEditor.description,
            is_private: parsedRubricFromEditor.is_private,
            rubric_parts: parsedRubricFromEditor.rubric_parts
          };
          setActiveRubric(updatedActiveFromDb);
          initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(updatedActiveFromDb));
        }
      } else {
        isNewRubricCreationFlow = true;
        baselineRubricForDiff = initialActiveRubricSnapshot.current
          ? initialActiveRubricSnapshot.current
          : createMinimalNewHydratedRubric(assignment_id as string, assignmentDetails.class_id, activeReviewRound);
        currentEffectiveRubricId = 0;
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

          const newlySavedRubricEntry: HydratedRubric = {
            ...activeRubric,
            ...newRubricPayload,
            id: currentEffectiveRubricId,
            created_at: new Date().toISOString(),
            rubric_parts: parsedRubricFromEditor.rubric_parts
          };
          setActiveRubric(newlySavedRubricEntry);
          initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(newlySavedRubricEntry));
        } catch (e) {
          toaster.create({ title: "Error Creating Rubric", description: (e as Error).message, type: "error" });
          setIsSaving(false);
          return;
        }
      } else {
        const topLevelRubricChanges: Partial<HydratedRubric> = {};
        if (parsedRubricFromEditor.name !== baselineRubricForDiff.name)
          topLevelRubricChanges.name = parsedRubricFromEditor.name;
        if (parsedRubricFromEditor.description !== baselineRubricForDiff.description)
          topLevelRubricChanges.description = parsedRubricFromEditor.description;
        if (parsedRubricFromEditor.is_private !== baselineRubricForDiff.is_private)
          topLevelRubricChanges.is_private = parsedRubricFromEditor.is_private;
        if (
          parsedRubricFromEditor.review_round !== baselineRubricForDiff.review_round &&
          parsedRubricFromEditor.review_round
        )
          topLevelRubricChanges.review_round = parsedRubricFromEditor.review_round;
        else if (activeReviewRound !== baselineRubricForDiff.review_round) {
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

      const partsToCompareAgainst = baselineRubricForDiff.rubric_parts;
      const partChanges = findChanges(parsedRubricFromEditor.rubric_parts, partsToCompareAgainst);

      const criteriaToCompareAgainst = baselineRubricForDiff.rubric_parts.flatMap((part) => part.rubric_criteria);
      const allNewCriteriaFromEditor = parsedRubricFromEditor.rubric_parts.flatMap((part) => part.rubric_criteria);
      const criteriaChanges = findChanges(allNewCriteriaFromEditor, criteriaToCompareAgainst);

      const checksToCompareAgainst = baselineRubricForDiff.rubric_parts.flatMap((part) =>
        part.rubric_criteria.flatMap((c) => c.rubric_checks)
      );
      const allNewChecksFromEditor = allNewCriteriaFromEditor.flatMap(
        (criteria: HydratedRubricCriteria) => criteria.rubric_checks
      );
      const checkChanges = findChanges(allNewChecksFromEditor, checksToCompareAgainst);

      await Promise.all(
        checkChanges.toDelete.map((id: number) =>
          deleteResource({
            id,
            resource: "rubric_checks",
            errorNotification: (error) => {
              toaster.error({
                title: "Failed to delete check",
                description: "The check could not be deleted because of an error: " + error
              });
              return false;
            }
          })
        )
      );

      await Promise.all(
        partChanges.toUpdate.map((part: HydratedRubricPart) =>
          updatePartIfChanged(
            part,
            baselineRubricForDiff.rubric_parts.find((p) => p.id === part.id) as HydratedRubricPart
          )
        )
      );

      await Promise.all(
        partChanges.toCreate.map(async (partData: HydratedRubricPart) => {
          const partCopy: Omit<
            HydratedRubricPart,
            "id" | "created_at" | "rubric_id" | "class_id" | "rubric_criteria"
          > & { rubric_id: number; class_id: number } = {
            name: partData.name,
            description: partData.description,
            ordinal: partData.ordinal,
            data: partData.data,
            class_id: assignmentDetails.class_id,
            rubric_id: currentEffectiveRubricId as number
          };
          const createdPart = await createResource({
            resource: "rubric_parts",
            values: partCopy
          });
          if (!createdPart.data.id) {
            throw new Error("Failed to create part");
          }
          const editorPart = parsedRubricFromEditor.rubric_parts.find(
            (p) => p.id === partData.id || (p.name === partData.name && p.ordinal === partData.ordinal)
          );
          if (editorPart) editorPart.id = createdPart.data.id as number;
        })
      );

      parsedRubricFromEditor.rubric_parts.forEach((part: HydratedRubricPart) => {
        part.rubric_criteria.forEach((criteria: HydratedRubricCriteria) => {
          criteria.rubric_part_id = part.id as number;
          criteria.class_id = assignmentDetails.class_id;
          criteria.rubric_id = currentEffectiveRubricId as number;
        });
      });

      await Promise.all(
        criteriaChanges.toUpdate.map((criteria: HydratedRubricCriteria) => {
          const existingCrit = baselineRubricForDiff.rubric_parts
            .flatMap((p: HydratedRubricPart) => p.rubric_criteria)
            .find((c: HydratedRubricCriteria) => c.id === criteria.id);
          if (existingCrit) {
            return updateCriteriaIfChanged(criteria, existingCrit);
          }
          return Promise.resolve();
        })
      );
      await Promise.all(
        criteriaChanges.toCreate.map(async (criteriaData: HydratedRubricCriteria) => {
          const criteriaCopy: Omit<
            HydratedRubricCriteria,
            "id" | "created_at" | "rubric_id" | "class_id" | "rubric_part_id" | "rubric_checks"
          > & { rubric_id: number; class_id: number; rubric_part_id: number } = {
            name: criteriaData.name,
            description: criteriaData.description,
            ordinal: criteriaData.ordinal,
            data: criteriaData.data,
            is_additive: criteriaData.is_additive,
            total_points: criteriaData.total_points,
            max_checks_per_submission: criteriaData.max_checks_per_submission,
            min_checks_per_submission: criteriaData.min_checks_per_submission,
            class_id: assignmentDetails.class_id,
            rubric_id: currentEffectiveRubricId as number,
            rubric_part_id: criteriaData.rubric_part_id as number
          };

          const parentPart = parsedRubricFromEditor.rubric_parts.find((p: HydratedRubricPart) =>
            p.rubric_criteria.some(
              (rc: HydratedRubricCriteria) =>
                rc.id === criteriaData.id || (rc.name === criteriaData.name && rc.ordinal === criteriaData.ordinal)
            )
          );
          if (parentPart && parentPart.id && parentPart.id > 0) {
            criteriaCopy.rubric_part_id = parentPart.id;
          } else {
            throw new Error(
              "Cannot create criteria: parent part ID invalid. Ensure parts are created and IDs updated first."
            );
          }

          const createdCriteria = await createResource({
            resource: "rubric_criteria",
            values: criteriaCopy
          });
          if (!createdCriteria.data.id) {
            throw new Error("Failed to create criteria");
          }
          const editorCriteria = allNewCriteriaFromEditor.find(
            (c) => c.id === criteriaData.id || (c.name === criteriaData.name && c.ordinal === criteriaData.ordinal)
          );
          if (editorCriteria) editorCriteria.id = createdCriteria.data.id as number;
        })
      );

      allNewCriteriaFromEditor.forEach((criteria: HydratedRubricCriteria) => {
        criteria.rubric_checks.forEach((check: HydratedRubricCheck) => {
          check.rubric_criteria_id = criteria.id as number;
          check.class_id = assignmentDetails.class_id;
        });
      });

      await Promise.all(
        checkChanges.toUpdate.map((check: HydratedRubricCheck) => {
          const existingChk = baselineRubricForDiff.rubric_parts
            .flatMap((p: HydratedRubricPart) => p.rubric_criteria)
            .flatMap((c: HydratedRubricCriteria) => c.rubric_checks)
            .find((ch: HydratedRubricCheck) => ch.id === check.id);
          if (existingChk) {
            return updateCheckIfChanged(check, existingChk);
          }
          return Promise.resolve();
        })
      );
      await Promise.all(
        checkChanges.toCreate.map(async (checkData: HydratedRubricCheck) => {
          const checkCopy: Omit<
            HydratedRubricCheck,
            "id" | "created_at" | "rubric_id" | "class_id" | "rubric_criteria_id"
          > & { class_id: number; rubric_criteria_id: number } = {
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
            rubric_criteria_id: checkData.rubric_criteria_id as number
          };
          const createdCheck = await createResource({
            resource: "rubric_checks",
            values: checkCopy
          });
          if (!createdCheck.data.id) {
            throw new Error("Failed to create check");
          }
          checkData.id = createdCheck.data.id as number;
        })
      );

      await Promise.all(
        criteriaChanges.toDelete.map((id: number) =>
          deleteResource({
            id,
            resource: "rubric_criteria"
          })
        )
      );
      await Promise.all(
        partChanges.toDelete.map((id: number) =>
          deleteResource({
            id,
            resource: "rubric_parts"
          })
        )
      );
    },
    [
      activeRubric,
      assignmentDetails,
      deleteResource,
      createResource,
      updateCriteriaIfChanged,
      updatePartIfChanged,
      updateCheckIfChanged,
      updateResource,
      assignment_id,
      activeReviewRound,
      allRubricsForAssignment,
      createMinimalNewHydratedRubric
    ]
  );

  if (isLoadingAssignment || isLoadingRubrics) {
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
                setActiveRubric(demoTemplate);
                initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(demoTemplate));
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
              setActiveRubric(undefined);
              initialActiveRubricSnapshot.current = undefined;
            }}
          >
            Reset
          </Button>
          <Button
            colorPalette="green"
            loading={isSaving}
            onClick={async () => {
              try {
                setIsSaving(true);
                await saveRubric(value);
                toaster.success({
                  title: "Rubric Saved",
                  description: "The rubric has been saved successfully."
                });
                await refetchAllRubrics();
                if (activeReviewRound) {
                  const updatedList = await refetchAllRubrics();
                  if (updatedList && updatedList.data && updatedList.data.data) {
                    const refreshedActive = updatedList.data.data.find(
                      (r: HydratedRubric) => r.review_round === activeReviewRound
                    );
                    if (refreshedActive) {
                      setActiveRubric(refreshedActive);
                      initialActiveRubricSnapshot.current = JSON.parse(JSON.stringify(refreshedActive));
                    } else {
                      setActiveRubric(undefined);
                      initialActiveRubricSnapshot.current = undefined;
                      if (REVIEW_ROUNDS_AVAILABLE[1]) handleReviewRoundChange(REVIEW_ROUNDS_AVAILABLE[1]);
                    }
                  }
                }
              } catch (error) {
                if (error instanceof Error) {
                  toaster.error({
                    title: "Failed to save rubric",
                    description:
                      "The rubric could not be saved because of an error. Please report this to the developers: " +
                      error.message +
                      ("details" in error ? ` (${(error as { details: string }).details})` : "")
                  });
                } else if (error && typeof error === "object" && ("details" in error || "message" in error)) {
                  toaster.error({
                    title: "Failed to save rubric",
                    description:
                      "The rubric could not be saved because of an error: " +
                      ((error as { message?: string }).message || "") +
                      ("details" in error ? ` (${(error as { details: string }).details})` : "")
                  });
                } else {
                  toaster.error({
                    title: "Failed to save rubric",
                    description: "An unknown error occurred: " + JSON.stringify(error)
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
        value={activeReviewRound || REVIEW_ROUNDS_AVAILABLE[0]}
        onValueChange={(details) => handleReviewRoundChange(details.value as HydratedRubric["review_round"])}
        lazyMount
        unmountOnExit
        mb={2}
      >
        <Tabs.List>
          {REVIEW_ROUNDS_AVAILABLE.map((rr) => (
            <Tabs.Trigger key={rr || "new"} value={rr || "new"}>
              {rr ? rr : "New Rubric"}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>
      <Flex w="100%" minW="0" flexGrow={1}>
        <Box w="100%" minW="0">
          <VStack w="100%" h="100%">
            <Editor
              height="calc(100vh - 150px)"
              width="100%"
              defaultLanguage="yaml"
              path="rubric.yml"
              beforeMount={handleEditorWillMount}
              value={value}
              theme={colorMode === "dark" ? "vs-dark" : "vs"}
              onValidate={(markers) => {
                if (markers.length > 0) {
                  setError("YAML syntax error. Please fix the errors in the editor.");
                  setErrorMarkers(markers);
                } else {
                  setError(undefined);
                  setErrorMarkers([]);
                }
              }}
              onChange={handleEditorChange}
            />
          </VStack>
        </Box>
        <Box w="lg" position="relative" h="calc(100vh - 100px)">
          {updatePaused && <Alert variant="surface">Preview paused while typing</Alert>}
          {!error && rubricForSidebar && <RubricSidebar initialRubric={rubricForSidebar} />}
          {error && (
            <Box
              position="absolute"
              top="0"
              left="0"
              width="100%"
              height="100%"
              backgroundColor="bg.error"
              display="flex"
              justifyContent="center"
              alignItems="center"
              zIndex="1"
            >
              <VStack>
                <Text color="fg.error">{error}</Text>
                <List.Root>
                  {errorMarkers.map((marker, index) => (
                    <List.Item key={index}>
                      <Text color="fg.error">
                        Line {marker.startLineNumber}: {marker.message}
                      </Text>
                    </List.Item>
                  ))}
                </List.Root>
              </VStack>
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
