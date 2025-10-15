"use client";
import { Alert } from "@/components/ui/alert";
import { useColorMode } from "@/components/ui/color-mode";
import { PreviewRubricProvider } from "@/components/ui/preview-rubric-provider";
import { RubricSidebar } from "@/components/ui/rubric-sidebar";
import { toaster, Toaster } from "@/components/ui/toaster";
import {
  useAssignmentController,
  useRubric,
  useRubricChecksByRubric,
  useRubricCriteriaByRubric,
  useRubricParts
} from "@/hooks/useAssignment";
import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  Json,
  RubricChecksDataType,
  YmlRubricChecksType,
  YmlRubricCriteriaType,
  YmlRubricPartType,
  YmlRubricType
} from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  Center,
  Flex,
  Heading,
  HStack,
  Icon,
  Link,
  List,
  Spinner,
  Tabs,
  Text,
  VStack
} from "@chakra-ui/react";
import Editor, { Monaco } from "@monaco-editor/react";
import { useCreate, useDataProvider, useDelete, useInvalidate, useUpdate } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaCheck } from "react-icons/fa6";
import * as Sentry from "@sentry/nextjs";
import * as YAML from "yaml";

const REVIEW_ROUNDS_AVAILABLE: Array<NonNullable<HydratedRubric["review_round"]>> = [
  "self-review",
  "grading-review",
  "meta-grading-review",
  "code-walk"
];

/**
 * Custom hook to get a fully hydrated rubric by review round
 */
function useHydratedRubricByReviewRound(
  review_round: NonNullable<HydratedRubric["review_round"]>
): HydratedRubric | undefined {
  const rubric = useRubric(review_round);
  const parts = useRubricParts(rubric?.id);
  const allCriteria = useRubricCriteriaByRubric(rubric?.id);
  const allChecks = useRubricChecksByRubric(rubric?.id);

  return useMemo(() => {
    if (!rubric || !parts || !allCriteria || !allChecks) return undefined;

    // Build the hydrated structure
    const hydratedParts: HydratedRubricPart[] = parts.map((part) => {
      const partCriteria = allCriteria.filter((c) => c.rubric_part_id === part.id);
      const hydratedCriteria: HydratedRubricCriteria[] = partCriteria.map((criteria) => {
        const criteriaChecks = allChecks.filter((ch) => ch.rubric_criteria_id === criteria.id);
        const hydratedChecks: HydratedRubricCheck[] = criteriaChecks.map((check) => ({
          ...check
        }));

        return {
          ...criteria,
          rubric_checks: hydratedChecks
        };
      });

      return {
        ...part,
        rubric_criteria: hydratedCriteria
      };
    });

    return {
      ...rubric,
      rubric_parts: hydratedParts
    };
  }, [rubric, parts, allCriteria, allChecks]);
}

function findChanges<T extends { id: number | undefined | null }>(
  newItems: T[],
  existingItems: T[]
): {
  toCreate: T[];
  toUpdate: T[];
  toDelete: number[];
  numItemsWithBadIDs: number;
} {
  const existingItemMap = new Map(existingItems.map((item) => [item.id, item]));

  const toCreate: T[] = [];
  const toUpdate: T[] = [];

  let numItemsWithBadIDs = 0;
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
        numItemsWithBadIDs++;
        toCreate.push(newItem);
      }
    }
  }

  const toDelete: number[] = Array.from(existingItemMap.keys()).filter(
    (id): id is number => id !== undefined && id !== null && id > 0
  );

  return { toCreate, toUpdate, toDelete, numItemsWithBadIDs };
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
    .map((check) => {
      const yamlCheck: Omit<YmlRubricChecksType, "data"> & { data?: Json | null } = {
        id: check.id,
        name: check.name,
        description: valOrUndefined(check.description),
        file: valOrUndefined(check.file),
        is_annotation: check.is_annotation,
        is_required: check.is_required,
        is_comment_required: check.is_comment_required,
        artifact: valOrUndefined(check.artifact),
        max_annotations: valOrUndefined(check.max_annotations),
        points: check.points,
        annotation_target: valOrUndefined(check.annotation_target) as "file" | "artifact" | undefined,
        student_visibility: valOrUndefined(check.student_visibility)
      };
      if (check.data !== null && check.data !== undefined) {
        yamlCheck.data = check.data;
      }
      return yamlCheck as YmlRubricChecksType;
    });
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
    description: valOrUndefined(rubric.description),
    parts: hydratedRubricPartToYamlRubric(rubric.rubric_parts)
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
    assignment_id: 0,
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
    annotation_target: valOrNull(check.annotation_target),
    student_visibility: check.student_visibility || "always"
  }));
}

function YamlCriteriaToHydratedCriteria(part_id: number, criteria: YmlRubricCriteriaType[]): HydratedRubricCriteria[] {
  return criteria.map((criteria, index) => ({
    id: criteria.id || -1,
    name: criteria.name,
    description: valOrNull(criteria.description),
    ordinal: index,
    rubric_id: 0,
    assignment_id: 0,
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
    assignment_id: 0,
    rubric_criteria: YamlCriteriaToHydratedCriteria(part.id || -1, part.criteria)
  }));
}

function YamlRubricToHydratedRubric(
  yaml: YmlRubricType,
  {
    assignment_id,
    is_private,
    review_round
  }: {
    assignment_id: number;
    is_private: boolean;
    review_round: NonNullable<HydratedRubric["review_round"]>;
  }
): HydratedRubric {
  return {
    id: 0,
    class_id: 0,
    created_at: "",
    name: yaml.name,
    assignment_id,
    description: valOrNull(yaml.description),
    rubric_parts: YamlPartsToHydratedParts(yaml.parts),
    is_private,
    review_round
  };
}

/**
 * Returns the property names of an object that have changed compared to another object, excluding arrays and certain metadata fields.
 *
 * Compares two objects of the same type and identifies which non-array, non-metadata properties have different values. For the `data` property, a deep comparison is performed using JSON stringification.
 *
 * @param newItem - The updated object to compare.
 * @param existingItem - The original object to compare against.
 * @returns An array of property names that have changed.
 */
function findUpdatedPropertyNames<T extends object>(newItem: T, existingItem: T): (keyof T)[] {
  return Object.keys(newItem)
    .filter(
      (key) =>
        !Array.isArray(newItem[key as keyof T]) &&
        key !== "rubric_id" &&
        key !== "class_id" &&
        key !== "created_at" &&
        key !== "assignment_id"
    )
    .filter(
      (key) =>
        (key === "data" &&
          newItem[key as keyof T] != existingItem[key as keyof T] &&
          JSON.stringify(newItem[key as keyof T]) != JSON.stringify(existingItem[key as keyof T])) ||
        newItem[key as keyof T] != existingItem[key as keyof T]
    ) as (keyof T)[];
}
/**
 * Renders the main rubric editing page for managing and editing handgrading rubrics.
 *
 * Displays the rubric editor interface with YAML editing, validation, and preview features.
 */
export default function RubricPage() {
  const assignmentController = useAssignmentController();
  const [ready, setReady] = useState(false);
  //Before showing the rubric page, force a refresh of all rubric data
  useEffect(() => {
    let cleanedUp = false;
    async function refreshRubricData() {
      if (cleanedUp) return;
      try {
        await Promise.all([
          assignmentController.rubricsController.refetchAll(),
          assignmentController.rubricPartsController.refetchAll(),
          assignmentController.rubricCriteriaController.refetchAll(),
          assignmentController.rubricChecksController.refetchAll(),
          assignmentController.rubricCheckReferencesController.refetchAll()
        ]);
      } catch (error) {
        Sentry.captureException(error);
        toaster.error({
          title: "Error refreshing rubric data",
          description: "An unexpected error occurred while refreshing the rubric data. Please try again later."
        });
      }
      if (cleanedUp) return;
      setReady(true);
    }
    refreshRubricData();
    return () => {
      cleanedUp = true;
    };
  }, [assignmentController]);
  if (!ready)
    return (
      <Center height="100%" width="100%">
        Refreshing rubric data...
        <Spinner />
      </Center>
    );
  return <InnerRubricPage />;
}
const MemoizedRubricSidebar = memo(RubricSidebar);
/**
 * Renders the main interface for editing, validating, and saving handgrading rubrics in YAML format for a specific assignment and review round.
 *
 * Provides a YAML editor with schema validation, a live rubric preview, and controls for switching between review rounds, loading demo templates, resetting, and saving. Manages rubric state, detects unsaved changes, and synchronizes rubric data with the backend, supporting creation, update, and deletion of rubric parts, criteria, and checks.
 */
function InnerRubricPage() {
  const assignmentController = useAssignmentController();
  const assignment_id = String(assignmentController.assignment?.id || "");
  const { colorMode } = useColorMode();
  const dataProviderHook = useDataProvider();

  const invalidate = useInvalidate();

  const assignmentDetails = assignmentController.assignment;
  const isLoadingAssignment = assignmentController.assignment === undefined;

  const [activeRubric, setActiveRubric] = useState<HydratedRubric | undefined>(undefined);
  const [initialActiveRubricSnapshot, setInitialActiveRubricSnapshot] = useState<HydratedRubric | undefined>(undefined);
  const [activeReviewRound, setActiveReviewRound] = useState<NonNullable<HydratedRubric["review_round"]>>(
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
  const wasRestoredFromStashRef = useRef(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [updatePaused, setUpdatePaused] = useState<boolean>(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  // Points summary state
  const gradingRubricFromDb = useRubric("grading-review");

  // Get rubric data for points calculation from database (when not in preview mode)
  const gradingRubricCriteria = useRubricCriteriaByRubric(gradingRubricFromDb?.id);
  const gradingRubricChecks = useRubricChecksByRubric(gradingRubricFromDb?.id);

  const assignmentMaxPoints = assignmentDetails?.total_points ?? 0;
  const autograderPoints = assignmentDetails?.autograder_points ?? 0;
  const gradingRubricPoints = useMemo(() => {
    // If we're previewing the grading-review, calculate from preview data
    if (activeReviewRound === "grading-review" && rubricForSidebar) {
      let total = 0;
      for (const part of rubricForSidebar.rubric_parts) {
        for (const criteria of part.rubric_criteria) {
          const criteriaTotal = criteria.total_points ?? 0;
          const sumCheckPoints = criteria.rubric_checks.reduce((acc: number, check) => acc + (check.points ?? 0), 0);

          if (criteria.is_additive) {
            total += Math.min(sumCheckPoints, criteriaTotal);
          } else {
            total += criteriaTotal;
          }
        }
      }
      return total;
    }

    // Otherwise calculate from database data
    if (!gradingRubricFromDb) return 0;
    let total = 0;

    if (!gradingRubricCriteria || !gradingRubricChecks) return undefined;
    for (const criteria of gradingRubricCriteria) {
      const criteriaTotal = criteria.total_points ?? 0;
      const checksForCriteria = gradingRubricChecks.filter((check) => check.rubric_criteria_id === criteria.id);
      const sumCheckPoints = checksForCriteria.reduce((acc: number, check) => acc + (check.points ?? 0), 0);

      if (criteria.is_additive) {
        total += Math.min(sumCheckPoints, criteriaTotal);
      } else {
        total += criteriaTotal;
      }
    }

    return total;
  }, [activeReviewRound, rubricForSidebar, gradingRubricFromDb, gradingRubricCriteria, gradingRubricChecks]);

  const addsUp = gradingRubricPoints !== undefined && assignmentMaxPoints === autograderPoints + gradingRubricPoints;

  const [unsavedStatusPerTab, setUnsavedStatusPerTab] = useState<Record<string, boolean>>(
    REVIEW_ROUNDS_AVAILABLE.reduce(
      (acc, round) => {
        if (round) acc[round] = false;
        return acc;
      },
      {} as Record<string, boolean>
    )
  );
  const [stashedEditorStates, setStashedEditorStates] = useState<
    Record<
      string,
      {
        value: string;
        initialSnapshot: HydratedRubric | undefined;
        activeRubricForSidebar: HydratedRubric | undefined;
      }
    >
  >({});
  const rubric = useHydratedRubricByReviewRound(activeReviewRound);
  useEffect(() => {
    setActiveRubric(rubric);
    setInitialActiveRubricSnapshot(rubric ? JSON.parse(JSON.stringify(rubric)) : undefined);
    setIsLoadingCurrentRubric(false);
  }, [rubric]);

  const refetchCurrentRubric = useCallback(() => {
    invalidate({ resource: "rubrics", invalidates: ["all"] });
    invalidate({ resource: "rubric_check_references", invalidates: ["all"] });
  }, [invalidate]);

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
      reviewRound: NonNullable<HydratedRubric["review_round"]>
    ): HydratedRubric => {
      const newRubricBase = YAML.parse(defaultRubric) as YmlRubricType;
      if (assignmentDetails?.title) {
        newRubricBase.name = `${assignmentDetails.title} - ${reviewRound
          ?.split("-")
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join(" ")} Rubric`;
      }

      const hydrated = YamlRubricToHydratedRubric(newRubricBase, {
        assignment_id: Number(currentAssignmentId),
        is_private: false,
        review_round: reviewRound
      });
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
    (newReviewRound: NonNullable<HydratedRubric["review_round"]>) => {
      if (!assignmentDetails || !assignment_id || newReviewRound === activeReviewRound) return;

      // Stash current tab's state if it has unsaved changes
      if (hasUnsavedChanges && activeReviewRound) {
        setStashedEditorStates((prev) => ({
          ...prev,
          [activeReviewRound]: {
            value: value,
            initialSnapshot: initialActiveRubricSnapshot,
            activeRubricForSidebar: rubricForSidebar
          }
        }));
        wasRestoredFromStashRef.current = false;
      }

      setIsLoadingCurrentRubric(true);
      // Clear current tab's specific states before switching
      setActiveRubric(undefined);
      // setInitialActiveRubricSnapshot(undefined); // This will be set by fetch or stash
      setValue("");
      setRubricForSidebar(undefined);
      // hasUnsavedChanges will be updated by useEffect or stash restoration

      if (stashedEditorStates[newReviewRound!]) {
        const stashed = stashedEditorStates[newReviewRound!];
        setValue(stashed.value);
        setInitialActiveRubricSnapshot(stashed.initialSnapshot);
        setRubricForSidebar(stashed.activeRubricForSidebar);
        setHasUnsavedChanges(true); // It was stashed because it had unsaved changes

        wasRestoredFromStashRef.current = true;

        // Remove from stash
        setStashedEditorStates((prev) => {
          const newState = { ...prev };
          delete newState[newReviewRound!];
          return newState;
        });
        setIsLoadingCurrentRubric(false);
        // Fetch in background to update initialActiveRubricSnapshot against DB,
        // but don't let it overwrite the editor value if the user starts typing.
        // The `onSuccess` of refetch will handle setting initialActiveRubricSnapshot.
        refetchCurrentRubric();
      } else {
        // No stashed state, so this tab will load fresh via useList effect
        setHasUnsavedChanges(false);
        wasRestoredFromStashRef.current = false;
      }
      setActiveReviewRound(newReviewRound);
    },
    [
      assignmentDetails,
      assignment_id,
      activeReviewRound,
      hasUnsavedChanges,
      value,
      initialActiveRubricSnapshot,
      rubricForSidebar,
      stashedEditorStates,
      refetchCurrentRubric
    ]
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
    (yamlValue: string, currentNumErrorMarkers?: number) => {
      if (yamlValue.trim() === "") {
        setRubricForSidebar(undefined);
        setError(undefined);
        // setHasUnsavedChanges might need to be true if the initial state was not empty.
        // This is handled by the dedicated useEffect for hasUnsavedChanges.
        return;
      }
      if (
        (currentNumErrorMarkers === undefined || currentNumErrorMarkers === 0) &&
        assignmentDetails &&
        activeReviewRound
      ) {
        try {
          const parsed = YAML.parse(yamlValue) as YmlRubricType;
          const hydratedFromYaml = YamlRubricToHydratedRubric(parsed, {
            assignment_id: Number(assignment_id),
            is_private: false,
            review_round: activeReviewRound
          });

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
    [activeRubric, assignmentDetails, assignment_id, activeReviewRound, createMinimalNewHydratedRubric]
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value) {
        setValue(value);
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }
        setUpdatePaused(true);
        const numErrorMarkers = errorMarkers.length;
        debounceTimeoutRef.current = setTimeout(() => {
          debouncedParseYaml(value, numErrorMarkers);
          setUpdatePaused(false);
        }, 1000);
      }
    },
    [debouncedParseYaml, errorMarkers.length]
  );

  useEffect(() => {
    if (wasRestoredFromStashRef.current) {
      // Content was from stash, value is already set. Debounced parse might still be needed for sidebar.
      // However, debouncedParseYaml is called in handleReviewRoundChange if restored from stash.
      // Or if activeRubric is set, it's called by the else if block below.
      // For now, if restored from stash, assume value and sidebar are handled.
      return;
    }

    if (activeRubric) {
      const yamlString = YAML.stringify(HydratedRubricToYamlRubric(activeRubric));
      setValue(yamlString);
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
      // Pass 0 for error markers, as this is a trusted source or new template
      debouncedParseYaml(yamlString, 0);
      setUpdatePaused(false);
    } else {
      // activeRubric is undefined.
      // This typically means no rubric from DB for this tab, or a reset to a non-existent state.
      if (initialActiveRubricSnapshot === undefined) {
        // Truly no rubric exists for this tab, and no demo/template has been loaded into activeRubric
        setValue(""); // Clear the editor
        if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
        debouncedParseYaml("", 0); // Clear the sidebar preview
        setUpdatePaused(false);
      } else {
        // This case might be less common: activeRubric is cleared, but there was a previous snapshot.
        // Still, treat as an empty state if activeRubric is gone.
        setValue("");
        if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
        debouncedParseYaml("", 0);
        setUpdatePaused(false);
      }
    }
  }, [
    activeRubric,
    debouncedParseYaml,
    assignmentDetails,
    activeReviewRound,
    assignment_id,
    createMinimalNewHydratedRubric,
    initialActiveRubricSnapshot,
    wasRestoredFromStashRef
  ]);

  useEffect(() => {
    if (!initialActiveRubricSnapshot && !value) {
      setHasUnsavedChanges(false);
      if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: false }));
      return;
    }
    if (!initialActiveRubricSnapshot && value) {
      setHasUnsavedChanges(true);
      if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: true }));
      return;
    }
    if (!value) {
      // No value - we are being triggered by a change in the review round
      return;
    }

    if (initialActiveRubricSnapshot) {
      const snapshotAsYamlString = YAML.stringify(HydratedRubricToYamlRubric(initialActiveRubricSnapshot));
      try {
        const parsedValue = YAML.parse(value);
        const currentEditorActiveRubric = YamlRubricToHydratedRubric(parsedValue, {
          assignment_id: Number(assignment_id),
          is_private: false,
          review_round: initialActiveRubricSnapshot.review_round || "grading-review"
        });

        // Ensure consistent fields for comparison
        currentEditorActiveRubric.review_round = initialActiveRubricSnapshot.review_round;
        currentEditorActiveRubric.assignment_id = initialActiveRubricSnapshot.assignment_id;
        currentEditorActiveRubric.class_id = initialActiveRubricSnapshot.class_id;
        currentEditorActiveRubric.id = initialActiveRubricSnapshot.id; // Important for diffing

        const currentEditorAsYamlString = YAML.stringify(HydratedRubricToYamlRubric(currentEditorActiveRubric));
        const changed = snapshotAsYamlString !== currentEditorAsYamlString;
        setHasUnsavedChanges(changed);
        if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: changed }));
      } catch {
        setHasUnsavedChanges(true);
        if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: true }));
      }
    } else {
      setHasUnsavedChanges(!!value);
    }
  }, [value, initialActiveRubricSnapshot, activeReviewRound, assignment_id]);

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
        toaster.create({
          title: "Error",
          description: "Cannot save: Missing assignment details or active review round.",
          type: "error"
        });
        return;
      }

      let parsedRubricFromEditor: HydratedRubric;
      try {
        parsedRubricFromEditor = YamlRubricToHydratedRubric(YAML.parse(yamlStringValue), {
          assignment_id: Number(assignment_id),
          is_private: false,
          review_round: activeReviewRound
        });
        parsedRubricFromEditor.assignment_id = Number(assignment_id);
        parsedRubricFromEditor.class_id = assignmentDetails.class_id;
        parsedRubricFromEditor.review_round = activeReviewRound;
      } catch (e) {
        toaster.error({ title: "YAML Error", description: `Invalid YAML: ${(e as Error).message}` });
        setIsSaving(false);
        return;
      }

      let currentEffectiveRubricId: number;
      let isNewRubricCreationFlow: boolean;
      let actualBaselineForDiff: HydratedRubric;

      const { getList } = dataProviderHook();
      const { data: existingRubricQuery } = await getList<HydratedRubric>({
        resource: "rubrics",
        filters: [
          { field: "assignment_id", operator: "eq", value: Number(assignment_id) },
          { field: "review_round", operator: "eq", value: activeReviewRound }
        ],
        pagination: { current: 1, pageSize: 1 },
        meta: { select: "*, rubric_parts(*, rubric_criteria(*, rubric_checks(*)))" }
      });

      const dbRubricForThisRound =
        existingRubricQuery && existingRubricQuery.length > 0 ? existingRubricQuery[0] : undefined;

      if (dbRubricForThisRound && dbRubricForThisRound.id > 0) {
        isNewRubricCreationFlow = false;
        currentEffectiveRubricId = dbRubricForThisRound.id;
        actualBaselineForDiff = dbRubricForThisRound;
        parsedRubricFromEditor.id = currentEffectiveRubricId;

        if (!initialActiveRubricSnapshot || initialActiveRubricSnapshot.id <= 0) {
          toaster.create({
            title: "Notice",
            description: "Updating existing rubric for this review round.",
            type: "info"
          });
        }
      } else {
        isNewRubricCreationFlow = true;
        currentEffectiveRubricId = 0;
        actualBaselineForDiff =
          initialActiveRubricSnapshot && initialActiveRubricSnapshot.id <= 0
            ? JSON.parse(JSON.stringify(initialActiveRubricSnapshot))
            : createMinimalNewHydratedRubric(assignment_id as string, assignmentDetails.class_id, activeReviewRound);
        if (actualBaselineForDiff.id !== 0) actualBaselineForDiff.id = 0;
        parsedRubricFromEditor.id = 0;
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
          invalidate({ resource: "assignments", invalidates: ["all"] });
          currentEffectiveRubricId = createdTopLevelRubric.data.id as number;
          if (!currentEffectiveRubricId) throw new Error("Failed to create rubric shell.");

          parsedRubricFromEditor.id = currentEffectiveRubricId;
        } catch (e) {
          toaster.create({ title: "Error Creating Rubric", description: (e as Error).message, type: "error" });
          setIsSaving(false);
          return;
        }
      } else {
        const topLevelRubricChanges: Partial<HydratedRubric> = {};
        if (parsedRubricFromEditor.name !== actualBaselineForDiff.name)
          topLevelRubricChanges.name = parsedRubricFromEditor.name;
        if (parsedRubricFromEditor.description !== actualBaselineForDiff.description)
          topLevelRubricChanges.description = parsedRubricFromEditor.description;
        if (parsedRubricFromEditor.is_private !== actualBaselineForDiff.is_private)
          topLevelRubricChanges.is_private = parsedRubricFromEditor.is_private;
        if (Object.keys(topLevelRubricChanges).length > 0) {
          await updateResource({
            id: currentEffectiveRubricId,
            resource: "rubrics",
            values: topLevelRubricChanges
          });
        }
      }

      parsedRubricFromEditor.rubric_parts.forEach((part) => {
        part.rubric_id = currentEffectiveRubricId;
        part.class_id = assignmentDetails.class_id;
        part.rubric_criteria.forEach((criteria) => {
          criteria.rubric_id = currentEffectiveRubricId;
          criteria.class_id = assignmentDetails.class_id;
        });
      });

      const partsToCompareAgainst = actualBaselineForDiff.rubric_parts;
      const partChanges = findChanges(parsedRubricFromEditor.rubric_parts, partsToCompareAgainst);

      const allNewCriteriaFromEditor = parsedRubricFromEditor.rubric_parts.flatMap((part) => part.rubric_criteria);
      const checksToCompareAgainst = actualBaselineForDiff.rubric_parts.flatMap((part) =>
        part.rubric_criteria.flatMap((c) => c.rubric_checks)
      );
      const allNewChecksFromEditor = allNewCriteriaFromEditor.flatMap(
        (criteria: HydratedRubricCriteria) => criteria.rubric_checks
      );
      const checkChanges = findChanges(allNewChecksFromEditor, checksToCompareAgainst);

      await Promise.all(checkChanges.toDelete.map((id: number) => deleteResource({ id, resource: "rubric_checks" })));

      const criteriaToCompareAgainst = actualBaselineForDiff.rubric_parts.flatMap((part) => part.rubric_criteria);
      const criteriaChanges = findChanges(allNewCriteriaFromEditor, criteriaToCompareAgainst);
      const totalItemsWithBadIDs =
        partChanges.numItemsWithBadIDs + criteriaChanges.numItemsWithBadIDs + checkChanges.numItemsWithBadIDs;
      if (totalItemsWithBadIDs > 0) {
        toaster.create({
          title: "Items in yml had invalid IDs",
          description: `${totalItemsWithBadIDs} items found with an "id" that appears to be a copy/paste from elsewhere. Treating as new items.`,
          type: "warning"
        });
      }

      await Promise.all(
        criteriaChanges.toDelete.map((id: number) => deleteResource({ id, resource: "rubric_criteria" }))
      );

      await Promise.all(partChanges.toDelete.map((id: number) => deleteResource({ id, resource: "rubric_parts" })));

      for (const partData of partChanges.toCreate) {
        const partCopy: Omit<HydratedRubricPart, "id" | "created_at" | "rubric_criteria"> = {
          name: partData.name,
          description: partData.description,
          ordinal: partData.ordinal,
          data: partData.data,
          class_id: assignmentDetails.class_id,
          rubric_id: currentEffectiveRubricId,
          assignment_id: assignmentDetails.id
        };
        const createdPart = await createResource({ resource: "rubric_parts", values: partCopy });
        if (!createdPart.data.id) throw new Error("Failed to create part");
        const editorPart = parsedRubricFromEditor.rubric_parts.find(
          (p) => p.id === partData.id || (p.name === partData.name && p.ordinal === partData.ordinal)
        );
        if (editorPart) editorPart.id = createdPart.data.id as number;
      }
      await Promise.all(
        partChanges.toUpdate.map((part: HydratedRubricPart) =>
          updatePartIfChanged(
            part,
            actualBaselineForDiff.rubric_parts.find((p) => p.id === part.id) as HydratedRubricPart
          )
        )
      );

      parsedRubricFromEditor.rubric_parts.forEach((part) => {
        part.rubric_criteria.forEach((criteria) => {
          if (part.id && part.id > 0) {
            criteria.rubric_part_id = part.id;
          } else {
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

      const finalAllNewCriteriaFromEditor = parsedRubricFromEditor.rubric_parts.flatMap((part) => part.rubric_criteria);
      const finalCriteriaChanges = findChanges(finalAllNewCriteriaFromEditor, criteriaToCompareAgainst);

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
          rubric_part_id: criteriaData.rubric_part_id,
          assignment_id: assignmentDetails.id
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

      finalAllNewCriteriaFromEditor.forEach((criteria) => {
        criteria.rubric_checks.forEach((check) => {
          if (criteria.id && criteria.id > 0) {
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

      const finalAllNewChecksFromEditor = finalAllNewCriteriaFromEditor.flatMap((c) => c.rubric_checks);
      const finalCheckChanges = findChanges(finalAllNewChecksFromEditor, checksToCompareAgainst);

      for (const checkData of finalCheckChanges.toCreate) {
        if (!checkData.rubric_criteria_id || checkData.rubric_criteria_id <= 0) {
          throw new Error(`Cannot create check '${checkData.name}': Missing or invalid parent criteria ID.`);
        }
        const checkCopy: Omit<HydratedRubricCheck, "id" | "created_at"> = {
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
          rubric_criteria_id: checkData.rubric_criteria_id,
          student_visibility: checkData.student_visibility || "always",
          assignment_id: assignmentDetails.id,
          rubric_id: currentEffectiveRubricId
        };
        const createdCheck = await createResource({ resource: "rubric_checks", values: checkCopy });
        if (!createdCheck.data.id) throw new Error("Failed to create check");
        checkData.id = createdCheck.data.id as number;
      }
      await Promise.all(
        finalCheckChanges.toUpdate.map((check: HydratedRubricCheck) => {
          const existingChk = checksToCompareAgainst.find((ch) => ch.id === check.id);
          if (existingChk) return updateCheckIfChanged(check, existingChk);
          return Promise.resolve();
        })
      );

      const finalSavedRubricState = JSON.parse(JSON.stringify(parsedRubricFromEditor));
      setActiveRubric(finalSavedRubricState);
      setInitialActiveRubricSnapshot(JSON.parse(JSON.stringify(finalSavedRubricState))); // Update state
      setHasUnsavedChanges(false); // Saved, so no unsaved changes
      if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: false }));
      // Clear any stashed state for this tab as it's now saved
      setStashedEditorStates((prev) => {
        const newState = { ...prev };
        if (activeReviewRound) delete newState[activeReviewRound];
        return newState;
      });

      await refetchCurrentRubric();
    },
    [
      assignmentDetails,
      activeReviewRound,
      dataProviderHook,
      createResource,
      updateResource,
      deleteResource,
      assignment_id,
      updatePartIfChanged,
      updateCriteriaIfChanged,
      updateCheckIfChanged,
      refetchCurrentRubric,
      createMinimalNewHydratedRubric,
      initialActiveRubricSnapshot,
      invalidate
    ]
  );

  if (isLoadingAssignment || (!activeRubric && isLoadingCurrentRubric && !initialActiveRubricSnapshot)) {
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
        <VStack align="start">
          <Heading size="md">
            {assignmentDetails?.title ? `${assignmentDetails.title}: ` : ""}Handgrading Rubrics
          </Heading>
          <Text fontSize="sm" color="fg.muted">
            Configure each rubric using the rich yaml editor. The &quot;Grading Review&quot; rubric is what will be used
            to grade submissions. We suggest configuring this rubric so that students can see the rubric before they
            submit. If you choose to assign a self-review round, the students will be assigned to complete that rubric.
            The &quot;Meta Grading Review&quot; rubric can be used to have an internal review of the grading rubric, and
            would typically be configured to be hidden from students. Read more about the rubric structure in the{" "}
            <Link href="https://docs.pawtograder.com/staff/assignments/rubrics">staff documentation</Link>.
          </Text>
          <Button
            variant="surface"
            size="xs"
            onClick={() => {
              if (assignmentDetails && activeReviewRound) {
                const demoTemplate = createNewRubricTemplate(
                  assignment_id as string,
                  assignmentDetails.class_id,
                  activeReviewRound
                );
                setActiveRubric(demoTemplate);
                setValue(YAML.stringify(HydratedRubricToYamlRubric(demoTemplate)));
                setStashedEditorStates((prev) => {
                  const newState = { ...prev };
                  if (activeReviewRound) delete newState[activeReviewRound];
                  return newState;
                });
                setHasUnsavedChanges(true);
                toaster.success({
                  title: "Demo Loaded",
                  description: "Demo rubric is loaded in the editor. Save to persist."
                });
              }
            }}
          >
            Load Demo Rubric
          </Button>
        </VStack>
      </HStack>
      <Tabs.Root
        value={activeReviewRound || REVIEW_ROUNDS_AVAILABLE[0]}
        onValueChange={(details) => {
          if (details.value) {
            handleReviewRoundChange(details.value as NonNullable<HydratedRubric["review_round"]>);
          }
        }}
        lazyMount
        unmountOnExit
        mb={0}
      >
        <Tabs.List>
          {REVIEW_ROUNDS_AVAILABLE.map((rr) => (
            <Tabs.Trigger key={rr || "undefined_round"} value={rr || "undefined_round_val"}>
              {" "}
              {rr
                ? rr
                    .split("-")
                    .map((w) => w[0].toUpperCase() + w.slice(1))
                    .join(" ")
                : "Select Round"}
              {unsavedStatusPerTab[rr!] ? "* (Unsaved Changes)" : ""}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>
      <VStack w="100%" h="100%" border="1px solid" borderColor={"border.subtle"}>
        <HStack pt={2} mt={0} bg="bg.subtle" w="100%" justifyContent="end">
          <Button
            variant="ghost"
            colorPalette="red"
            size="xs"
            onClick={() => {
              if (initialActiveRubricSnapshot) {
                setActiveRubric(JSON.parse(JSON.stringify(initialActiveRubricSnapshot)));
                setValue(YAML.stringify(HydratedRubricToYamlRubric(initialActiveRubricSnapshot)));
                toaster.create({
                  title: "Reset",
                  description: "Editor reset to last saved state for this tab.",
                  type: "info"
                });
              } else {
                if (assignmentDetails && activeReviewRound) {
                  const minimal = createMinimalNewHydratedRubric(
                    assignment_id as string,
                    assignmentDetails.class_id,
                    activeReviewRound
                  );
                  setActiveRubric(minimal);
                  setInitialActiveRubricSnapshot(JSON.parse(JSON.stringify(minimal)));
                  setValue("");
                } else {
                  setActiveRubric(undefined);
                  setInitialActiveRubricSnapshot(undefined);
                  setValue("");
                }
                toaster.create({
                  title: "Reset",
                  description: "Editor reset to an empty state for this tab.",
                  type: "info"
                });
              }
              setHasUnsavedChanges(false);
              if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: false }));
              setStashedEditorStates((prev) => {
                const newState = { ...prev };
                if (activeReviewRound) delete newState[activeReviewRound];
                return newState;
              });
            }}
          >
            Reset
          </Button>
          <Button
            colorPalette="green"
            loadingText="Saving..."
            loading={isSaving}
            disabled={isSaving || !hasUnsavedChanges}
            onClick={async () => {
              try {
                setIsSaving(true);
                await saveRubric(value);
                toaster.success({
                  title: "Rubric Saved",
                  description: "The rubric has been saved successfully."
                });
              } catch (error) {
                Sentry.captureException(error);
                console.error(error);
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
        <Flex w="100%" minW="0" flexGrow={1}>
          <Box w="100%" minW="0">
            <VStack w="100%" h="100%">
              {isLoadingCurrentRubric && !activeRubric && (
                <Center height="calc(100vh - 150px)" width="100%">
                  <Spinner size="xl" />
                </Center>
              )}
              {/* keep the editor mounted at all times when it is doing work, otherwise there will be a runtime error */}
              <Box position="relative" w="100%" h="calc(100vh - 150px)">
                <Editor
                  height="calc(100vh - 150px)"
                  width="100%"
                  defaultLanguage="yaml"
                  path={`rubric-${activeReviewRound || "new"}.yml`}
                  beforeMount={handleEditorWillMount}
                  value={value}
                  theme={colorMode === "dark" ? "vs-dark" : "vs"}
                  onValidate={(markers) => {
                    // If the editor is empty, don't show schema validation errors.
                    // Schema errors for an empty document are not helpful.
                    if (value.trim() === "") {
                      setError(undefined);
                      setErrorMarkers([]);
                      return;
                    }

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

                {isLoadingCurrentRubric && !activeRubric && (
                  <Center
                    position="absolute"
                    top={0}
                    left={0}
                    width="100%"
                    height="100%"
                    bg="bg.surface"
                    opacity={0.7}
                    zIndex={1}
                  >
                    <Spinner size="xl" />
                  </Center>
                )}

                {isSaving && (
                  <Center
                    position="absolute"
                    top={0}
                    left={0}
                    width="100%"
                    height="100%"
                    bg="bg.surface"
                    opacity={0.7}
                    zIndex={2}
                  >
                    <Spinner size="xl" />
                  </Center>
                )}
              </Box>
            </VStack>
          </Box>
          <Box w="lg" position="relative" h="calc(100vh - 100px)" overflowY="auto">
            {updatePaused && <Alert variant="surface">Preview paused while typing</Alert>}

            {/* Points summary for autograder vs grading rubric vs assignment total */}
            {rubric?.review_round === "grading-review" && (
              <Box
                role="region"
                border="1px solid"
                borderColor="border.subtle"
                aria-label="Grading Rubric Points Summary"
                mt={2}
                mb={4}
                p={3}
                borderRadius="md"
                bg={addsUp ? "bg.info" : "bg.warning"}
              >
                <Heading size="sm" mb={1}>
                  Grading Rubric Points Summary
                </Heading>
                <Text fontSize="sm" color="fg.muted">
                  The assignment&apos;s max points is set to {assignmentMaxPoints}, and the autograder is currently
                  configured to award up to {autograderPoints} points, and the grading rubric is configured to award{" "}
                  {gradingRubricPoints} points. {addsUp && <Icon as={FaCheck} color="fg.success" />}
                </Text>
                {!addsUp && gradingRubricPoints !== undefined && (
                  <Text fontSize="sm" mt={1}>
                    These do not add up to the assignment max points.{" "}
                    {gradingRubricPoints < assignmentMaxPoints - autograderPoints
                      ? `Update the autograder to award +${assignmentMaxPoints - autograderPoints - gradingRubricPoints} points.`
                      : `Update the grading rubric to remove ${Math.abs(assignmentMaxPoints - autograderPoints - gradingRubricPoints)} points.`}
                  </Text>
                )}
              </Box>
            )}

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
                  <Text fontSize="sm">Load a demo template or start typing in the editor to see a preview.</Text>
                </VStack>
              </Center>
            )}

            {!error && rubricForSidebar && (
              <PreviewRubricProvider rubricData={rubricForSidebar}>
                <VStack gap={4} align="stretch">
                  <MemoizedRubricSidebar rubricId={rubricForSidebar.id} />
                </VStack>
              </PreviewRubricProvider>
            )}
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
      </VStack>
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
            student_visibility: if_applied
          - name: Missing documentation
            description: Max 10 annotations per-submission. Comment optional.
            is_annotation: true
            is_required: false
            is_comment_required: false
            max_annotations: 10
            points: 2
            student_visibility: if_released
          - name: Internal grader note
            description: Flag for meta-grader review - never visible to students
            is_annotation: true
            is_required: false
            is_comment_required: true
            max_annotations: 1
            points: 0
            student_visibility: never
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
            student_visibility: always
          - name: It's mediocre
            description: Something's not quite right, the grader has added comments to
              explain
            is_annotation: false
            is_required: false
            is_comment_required: true
            max_annotations: 1
            points: 5
            student_visibility: always
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
            student_visibility: if_applied
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
            student_visibility: if_applied
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
            student_visibility: always
          - name: Some option 2
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: always
          - name: Some option 3
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_released
          - name: Some option 4
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_applied
          - name: Some option 5
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_applied
          - name: Some option 6
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_applied
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
            student_visibility: always
          - name: Some option 2
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_released
          - name: Some option 3
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_applied
          - name: Some option 4
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_applied
          - name: Some option 5
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_applied
          - name: Some option 6
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
            student_visibility: if_applied
is_private: false
`;
