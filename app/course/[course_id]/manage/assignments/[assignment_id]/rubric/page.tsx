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
  useRubricParts,
  useRubrics
} from "@/hooks/useAssignment";
import { useListTableControllerValues } from "@/lib/TableController";
import type { RubricCheckReference } from "@/utils/supabase/DatabaseTypes";
import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
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
import { useCreate, useDataProvider, useDelete, useInvalidate, useUpdate } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  clearRubricUnsavedChangesFlag,
  RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE,
  setRubricUnsavedChangesFlag
} from "@/lib/rubricUnsavedChanges";
import {
  findChanges,
  findUpdatedPropertyNames,
  HydratedRubricToYamlRubric,
  resolveReferences,
  YamlRubricToHydratedRubric
} from "@/lib/rubric";
import { RubricEditorTree, validateRubric } from "@/components/rubric-editor";

// Dynamic import of Monaco Editor to reduce build memory usage
const Editor = dynamic(() => import("@monaco-editor/react").then((mod) => mod.default), {
  ssr: false,
  loading: () => <Spinner size="lg" />
});

// Import Monaco type separately for type checking
import type { Monaco } from "@monaco-editor/react";
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
function useReferencesForRubric(rubric_id: number | null | undefined) {
  const controller = useAssignmentController();
  const predicate = useCallback((row: RubricCheckReference) => row.rubric_id === rubric_id, [rubric_id]);
  return useListTableControllerValues(controller.rubricCheckReferencesController, predicate);
}

function useHydratedRubricByReviewRound(
  review_round: NonNullable<HydratedRubric["review_round"]>
): HydratedRubric | undefined {
  const rubric = useRubric(review_round);
  const parts = useRubricParts(rubric?.id);
  const allCriteria = useRubricCriteriaByRubric(rubric?.id);
  const allChecks = useRubricChecksByRubric(rubric?.id);
  const allReferences = useReferencesForRubric(rubric?.id);

  return useMemo(() => {
    if (!rubric || !parts || !allCriteria || !allChecks) return undefined;

    // Build the hydrated structure
    const hydratedParts: HydratedRubricPart[] = parts.map((part) => {
      const partCriteria = allCriteria.filter((c) => c.rubric_part_id === part.id);
      const hydratedCriteria: HydratedRubricCriteria[] = partCriteria.map((criteria) => {
        const criteriaChecks = allChecks.filter((ch) => ch.rubric_criteria_id === criteria.id);
        const hydratedChecks: HydratedRubricCheck[] = criteriaChecks.map((check) => {
          const refs = (allReferences ?? [])
            .filter((r) => r.referencing_rubric_check_id === check.id)
            .map((r) => ({ id: r.id, referenced_rubric_check_id: r.referenced_rubric_check_id }));
          return {
            ...check,
            references: refs
          };
        });

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
  }, [rubric, parts, allCriteria, allChecks, allReferences]);
}

/**
 * Hydrate all rubrics on this assignment (parts + criteria + checks) without
 * loading references. Used at save time to resolve cross-round references and
 * by the GUI typeahead to enumerate candidate targets.
 */
function useAllHydratedRubrics(): HydratedRubric[] {
  const controller = useAssignmentController();
  const rubrics = useRubrics();
  const parts = useListTableControllerValues(
    controller.rubricPartsController,
    useCallback(() => true, [])
  );
  const criteria = useListTableControllerValues(
    controller.rubricCriteriaController,
    useCallback(() => true, [])
  );
  const checks = useListTableControllerValues(
    controller.rubricChecksController,
    useCallback(() => true, [])
  );
  return useMemo(() => {
    if (!rubrics) return [];
    return rubrics.map((r) => {
      const rParts = (parts ?? [])
        .filter((p) => p.rubric_id === r.id)
        .map((part) => {
          const rCrits = (criteria ?? [])
            .filter((c) => c.rubric_part_id === part.id)
            .map((crit) => {
              const rChecks = (checks ?? [])
                .filter((ch) => ch.rubric_criteria_id === crit.id)
                .map((ch) => ({ ...ch }) as HydratedRubricCheck);
              return { ...crit, rubric_checks: rChecks } as HydratedRubricCriteria;
            });
          return { ...part, rubric_criteria: rCrits } as HydratedRubricPart;
        });
      return { ...r, rubric_parts: rParts } as HydratedRubric;
    });
  }, [rubrics, parts, criteria, checks]);
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
        return;
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
  const VIEW_MODE_STORAGE_KEY = "pawtograder:rubric-editor:viewMode";
  const [viewMode, setViewMode] = useState<"gui" | "source">("gui");
  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (stored === "gui" || stored === "source") setViewMode(stored);
    } catch {
      // sessionStorage may be unavailable; default stands.
    }
  }, []);
  const persistViewMode = useCallback((next: "gui" | "source") => {
    setViewMode(next);
    try {
      window.sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
    } catch {
      // Ignore restricted storage environments.
    }
  }, []);

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

  const isCapped = gradingRubricFromDb?.cap_score_to_assignment_points ?? false;
  const addsUp =
    gradingRubricPoints !== undefined &&
    (isCapped
      ? Math.max(autograderPoints, gradingRubricPoints) <= assignmentMaxPoints
      : assignmentMaxPoints === autograderPoints + gradingRubricPoints);

  const assignmentControllerForRefs = useAssignmentController();
  const allHydratedRubrics = useAllHydratedRubrics();
  const [unsavedStatusPerTab, setUnsavedStatusPerTab] = useState<Record<string, boolean>>(
    REVIEW_ROUNDS_AVAILABLE.reduce(
      (acc, round) => {
        if (round) acc[round] = false;
        return acc;
      },
      {} as Record<string, boolean>
    )
  );
  const hasAnyUnsavedChanges = useMemo(
    () => hasUnsavedChanges || Object.values(unsavedStatusPerTab).some(Boolean),
    [hasUnsavedChanges, unsavedStatusPerTab]
  );
  const hasAnyUnsavedChangesRef = useRef(hasAnyUnsavedChanges);
  const shouldSkipNextPopStateWarningRef = useRef(false);
  const isRubricFlagOwnerRef = useRef(false);
  const rubricFlagOwnerIdRef = useRef(`rubric-editor-${Math.random().toString(36).slice(2)}`);
  const [rubricPageRootElement, setRubricPageRootElement] = useState<HTMLDivElement | null>(null);
  const [isRubricPageInstanceVisible, setIsRubricPageInstanceVisible] = useState<boolean>(false);
  const rubricUnsavedChangesOwnerStorageKey = useMemo(() => {
    if (!assignment_id) return null;
    return `pawtograder:rubric-unsaved-changes-owner:${assignment_id}`;
  }, [assignment_id]);
  const computeRubricPageInstanceVisibility = useCallback(() => {
    if (!rubricPageRootElement) return false;
    const computedStyle = window.getComputedStyle(rubricPageRootElement);
    return (
      rubricPageRootElement.getClientRects().length > 0 &&
      computedStyle.display !== "none" &&
      computedStyle.visibility !== "hidden"
    );
  }, [rubricPageRootElement]);
  const syncRubricUnsavedChangesFlagOwner = useCallback(
    (visibilityOverride?: boolean) => {
      if (!assignment_id || !rubricUnsavedChangesOwnerStorageKey) return;
      const isVisible = visibilityOverride ?? isRubricPageInstanceVisible;
      const ownerId = rubricFlagOwnerIdRef.current;

      if (isVisible) {
        try {
          window.sessionStorage.setItem(rubricUnsavedChangesOwnerStorageKey, ownerId);
        } catch {
          // Ignore restricted storage environments.
        }
        setRubricUnsavedChangesFlag(assignment_id, hasAnyUnsavedChangesRef.current);
        isRubricFlagOwnerRef.current = true;
        return;
      }

      if (!isRubricFlagOwnerRef.current) return;
      let currentOwnerId: string | null = null;
      try {
        currentOwnerId = window.sessionStorage.getItem(rubricUnsavedChangesOwnerStorageKey);
      } catch {
        // Ignore restricted storage environments.
      }
      if (currentOwnerId && currentOwnerId !== ownerId) {
        isRubricFlagOwnerRef.current = false;
        return;
      }
      clearRubricUnsavedChangesFlag(assignment_id);
      try {
        window.sessionStorage.removeItem(rubricUnsavedChangesOwnerStorageKey);
      } catch {
        // Ignore restricted storage environments.
      }
      isRubricFlagOwnerRef.current = false;
    },
    [assignment_id, isRubricPageInstanceVisible, rubricUnsavedChangesOwnerStorageKey]
  );

  useLayoutEffect(() => {
    hasAnyUnsavedChangesRef.current = hasAnyUnsavedChanges;
    syncRubricUnsavedChangesFlagOwner();
  }, [hasAnyUnsavedChanges, syncRubricUnsavedChangesFlagOwner]);

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
        created_at: "", // Will be set by DB
        cap_score_to_assignment_points: false
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
            cap_score_to_assignment_points: hydratedFromYaml.cap_score_to_assignment_points ?? false,
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

  const handleGuiChange = useCallback((next: HydratedRubric) => {
    setActiveRubric(next);
    const yamlString = YAML.stringify(HydratedRubricToYamlRubric(next));
    setValue(yamlString);
    // GUI edits skip the parse debounce — the rubric is already structured.
    setRubricForSidebar(next);
    setError(undefined);
    setUpdatePaused(false);
    if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
  }, []);

  const guiValidationErrors = useMemo(() => (activeRubric ? validateRubric(activeRubric) : []), [activeRubric]);

  const handleViewModeChange = useCallback(
    (next: "gui" | "source") => {
      if (next === viewMode) return;
      if (next === "gui") {
        if (!value || value.trim() === "") {
          persistViewMode("gui");
          return;
        }
        try {
          const parsed = YAML.parse(value) as YmlRubricType;
          const hydrated = YamlRubricToHydratedRubric(parsed, {
            assignment_id: Number(assignment_id),
            is_private: false,
            review_round: activeReviewRound
          });
          if (assignmentDetails) {
            hydrated.assignment_id = Number(assignment_id);
            hydrated.class_id = assignmentDetails.class_id;
          }
          hydrated.review_round = activeReviewRound;
          if (activeRubric && activeRubric.id > 0) hydrated.id = activeRubric.id;
          setActiveRubric(hydrated);
          setRubricForSidebar(hydrated);
          setError(undefined);
          persistViewMode("gui");
        } catch (e) {
          toaster.error({
            title: "Cannot switch to GUI",
            description: `YAML must be valid before switching: ${(e as Error).message}`
          });
        }
      } else {
        // GUI -> Source. `value` is already kept in sync with activeRubric by handleGuiChange.
        persistViewMode("source");
      }
    },
    [viewMode, value, persistViewMode, assignment_id, activeReviewRound, assignmentDetails, activeRubric]
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

  useEffect(() => {
    if (!rubricPageRootElement) return;

    const handleVisibilityChange = () => {
      const isVisible = computeRubricPageInstanceVisibility();
      setIsRubricPageInstanceVisible((previousVisibility) => {
        if (previousVisibility === isVisible) return previousVisibility;
        // Keep ownership state in sync immediately when visibility flips.
        syncRubricUnsavedChangesFlagOwner(isVisible);
        return isVisible;
      });
    };

    handleVisibilityChange();

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => handleVisibilityChange());
      resizeObserver.observe(rubricPageRootElement);
    }

    let intersectionObserver: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      intersectionObserver = new IntersectionObserver(() => handleVisibilityChange(), {
        threshold: [0, 0.01]
      });
      intersectionObserver.observe(rubricPageRootElement);
    }

    window.addEventListener("resize", handleVisibilityChange);
    return () => {
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener("resize", handleVisibilityChange);
    };
  }, [computeRubricPageInstanceVisibility, rubricPageRootElement, syncRubricUnsavedChangesFlagOwner]);

  useEffect(
    () => () => {
      if (!assignment_id || !rubricUnsavedChangesOwnerStorageKey || !isRubricFlagOwnerRef.current) return;
      let currentOwnerId: string | null = null;
      try {
        currentOwnerId = window.sessionStorage.getItem(rubricUnsavedChangesOwnerStorageKey);
      } catch {
        // Ignore restricted storage environments.
      }
      if (currentOwnerId && currentOwnerId !== rubricFlagOwnerIdRef.current) {
        isRubricFlagOwnerRef.current = false;
        return;
      }
      clearRubricUnsavedChangesFlag(assignment_id);
      try {
        window.sessionStorage.removeItem(rubricUnsavedChangesOwnerStorageKey);
      } catch {
        // Ignore restricted storage environments.
      }
      isRubricFlagOwnerRef.current = false;
    },
    [assignment_id, rubricUnsavedChangesOwnerStorageKey]
  );

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isRubricPageInstanceVisible) return;
      if (!hasAnyUnsavedChangesRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };

    const handlePopState = () => {
      if (!isRubricPageInstanceVisible) return;
      if (shouldSkipNextPopStateWarningRef.current) {
        shouldSkipNextPopStateWarningRef.current = false;
        return;
      }
      if (!hasAnyUnsavedChangesRef.current) return;

      const shouldLeave = window.confirm(RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE);
      if (shouldLeave) return;

      shouldSkipNextPopStateWarningRef.current = true;
      window.history.go(1);
    };

    const handleDocumentClick = (event: MouseEvent) => {
      if (!isRubricPageInstanceVisible) return;
      if (!hasAnyUnsavedChangesRef.current || event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      const currentUrl = new URL(window.location.href);
      const nextUrl = new URL(href, window.location.href);
      const isSameDocumentLocation =
        currentUrl.origin === nextUrl.origin &&
        currentUrl.pathname === nextUrl.pathname &&
        currentUrl.search === nextUrl.search;

      if (isSameDocumentLocation) return;

      const shouldLeave = window.confirm(RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE);
      if (shouldLeave) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("click", handleDocumentClick, true);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("click", handleDocumentClick, true);
    };
  }, [isRubricPageInstanceVisible]);

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
          review_round: activeReviewRound,
          cap_score_to_assignment_points: parsedRubricFromEditor.cap_score_to_assignment_points ?? false
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
        if (
          parsedRubricFromEditor.cap_score_to_assignment_points !== actualBaselineForDiff.cap_score_to_assignment_points
        )
          topLevelRubricChanges.cap_score_to_assignment_points =
            parsedRubricFromEditor.cap_score_to_assignment_points ?? false;
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
          assignment_id: assignmentDetails.id,
          is_individual_grading: partData.is_individual_grading ?? false,
          is_assign_to_student: partData.is_assign_to_student ?? false
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
          is_deduction_only: criteriaData.is_deduction_only || false,
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
          rubric_id: currentEffectiveRubricId,
          kpi_category: checkData.kpi_category
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

      // ---- References ----
      // Now that all checks for this rubric have real DB ids, resolve & sync references.
      // We resolve YAML references against the *current* set of other rubrics, then
      // diff the desired set against the existing reference rows owned by this rubric.
      const otherHydratedRubrics = allHydratedRubrics.filter((r) => r.id !== currentEffectiveRubricId);
      const referencesUnsavedNotice: string[] = [];
      const referenceErrors: string[] = [];
      const desiredReferenceRows: Array<{
        existingRowId?: number;
        referencing_rubric_check_id: number;
        referenced_rubric_check_id: number;
      }> = [];

      for (const part of parsedRubricFromEditor.rubric_parts) {
        for (const crit of part.rubric_criteria) {
          for (const check of crit.rubric_checks) {
            // The check id was assigned above (toCreate path) or already real. Skip if still bogus.
            if (!check.id || check.id <= 0) continue;
            const yamlRefs = check.yaml_references;
            if (!yamlRefs || yamlRefs.length === 0) continue;

            // Reject any references whose target is in a sibling tab with unsaved changes —
            // we don't yet know the final ids over there.
            const filteredYamlRefs = yamlRefs.filter((ref) => {
              // Try to determine the target review round, either explicitly or via the resolved id.
              const targetRound = ref.review_round;
              if (targetRound && unsavedStatusPerTab[targetRound]) {
                referencesUnsavedNotice.push(targetRound);
                return false;
              }
              return true;
            });

            const { resolved, errors } = resolveReferences(filteredYamlRefs, {
              otherRubrics: otherHydratedRubrics,
              currentReviewRound: activeReviewRound,
              existingReferences: (assignmentControllerForRefs.rubricCheckReferencesController.rows ?? [])
                .filter((r) => r.referencing_rubric_check_id === check.id)
                .map((r) => ({ id: r.id, referenced_rubric_check_id: r.referenced_rubric_check_id }))
            });
            for (const e of errors) referenceErrors.push(`${check.name}: ${e}`);
            for (const r of resolved) {
              desiredReferenceRows.push({
                existingRowId: r.id,
                referencing_rubric_check_id: check.id,
                referenced_rubric_check_id: r.referenced_rubric_check_id
              });
            }
          }
        }
      }

      // Reference rows in the DB owned by this rubric (filtered by rubric_id).
      const existingReferenceRows = (assignmentControllerForRefs.rubricCheckReferencesController.rows ?? []).filter(
        (row) => row.rubric_id === currentEffectiveRubricId
      );
      // Build set of "desired" identities: pair of (referencing_check_id, referenced_check_id).
      const desiredKey = (a: number, b: number) => `${a}:${b}`;
      const desiredSet = new Set(
        desiredReferenceRows.map((r) => desiredKey(r.referencing_rubric_check_id, r.referenced_rubric_check_id))
      );
      const existingSet = new Set(
        existingReferenceRows.map((r) => desiredKey(r.referencing_rubric_check_id, r.referenced_rubric_check_id))
      );

      const toDeleteRefRows = existingReferenceRows.filter(
        (row) => !desiredSet.has(desiredKey(row.referencing_rubric_check_id, row.referenced_rubric_check_id))
      );
      const toCreateRefRows = desiredReferenceRows.filter(
        (row) => !existingSet.has(desiredKey(row.referencing_rubric_check_id, row.referenced_rubric_check_id))
      );

      await Promise.all(
        toDeleteRefRows.map((row) => deleteResource({ resource: "rubric_check_references", id: row.id }))
      );
      for (const row of toCreateRefRows) {
        await createResource({
          resource: "rubric_check_references",
          values: {
            assignment_id: assignmentDetails.id,
            class_id: assignmentDetails.class_id,
            rubric_id: currentEffectiveRubricId,
            referencing_rubric_check_id: row.referencing_rubric_check_id,
            referenced_rubric_check_id: row.referenced_rubric_check_id
          }
        });
      }

      const uniqueUnsavedRounds = Array.from(new Set(referencesUnsavedNotice));
      for (const round of uniqueUnsavedRounds) {
        toaster.warning({
          title: "Reference target unsaved",
          description: `Save '${round}' first to finalize the cross-round reference(s).`
        });
      }
      for (const err of referenceErrors) {
        toaster.warning({ title: "Reference not saved", description: err });
      }

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
      invalidate,
      allHydratedRubrics,
      assignmentControllerForRefs,
      unsavedStatusPerTab
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
    <Flex ref={setRubricPageRootElement} w="100%" minW="0" direction="column">
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
        <HStack pt={2} mt={0} bg="bg.subtle" w="100%" justifyContent="space-between" px={2}>
          <HStack gap={1}>
            <Button
              size="xs"
              variant={viewMode === "gui" ? "solid" : "ghost"}
              onClick={() => handleViewModeChange("gui")}
            >
              GUI
            </Button>
            <Button
              size="xs"
              variant={viewMode === "source" ? "solid" : "ghost"}
              onClick={() => handleViewModeChange("source")}
            >
              YAML source
            </Button>
          </HStack>
          <HStack>
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
        </HStack>
        <Flex w="100%" minW="0" flexGrow={1}>
          <Box w="100%" minW="0">
            <VStack w="100%" h="100%">
              {isLoadingCurrentRubric && !activeRubric && (
                <Center height="calc(100vh - 150px)" width="100%">
                  <Spinner size="xl" />
                </Center>
              )}
              {viewMode === "gui" && activeRubric && (
                <Box w="100%" h="calc(100vh - 150px)" overflowY="auto">
                  <RubricEditorTree
                    rubric={activeRubric}
                    onChange={handleGuiChange}
                    validationErrors={guiValidationErrors}
                    assignmentMaxPoints={assignmentMaxPoints}
                    autograderPoints={autograderPoints}
                    referenceContext={{
                      otherRubrics: allHydratedRubrics.filter((r) => r.review_round !== activeReviewRound),
                      unsavedRoundTabs: unsavedStatusPerTab
                    }}
                  />
                </Box>
              )}
              {viewMode === "gui" && !activeRubric && (
                <Center h="calc(100vh - 150px)" w="100%">
                  <VStack>
                    <Text>No rubric configured for this review round.</Text>
                    <Text fontSize="sm" color="fg.muted">
                      Load a demo template or switch to YAML to paste one in.
                    </Text>
                  </VStack>
                </Center>
              )}
              {/* keep the editor mounted at all times when it is doing work, otherwise there will be a runtime error */}
              <Box
                position="relative"
                w="100%"
                h="calc(100vh - 150px)"
                display={viewMode === "source" ? "block" : "none"}
              >
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
                {isCapped && (
                  <Text fontSize="sm" mt={1} color="fg.muted">
                    Score capping is enabled. Manual grading can be used as a fallback when autograder fails, with the
                    final score capped to {assignmentMaxPoints} points.
                  </Text>
                )}
                {!addsUp && gradingRubricPoints !== undefined && !isCapped && (
                  <Text fontSize="sm" mt={1}>
                    These do not add up to the assignment max points.{" "}
                    {gradingRubricPoints < assignmentMaxPoints - autograderPoints
                      ? `Update the autograder to award +${assignmentMaxPoints - autograderPoints - gradingRubricPoints} points.`
                      : `Update the grading rubric to remove ${Math.abs(assignmentMaxPoints - autograderPoints - gradingRubricPoints)} points.`}
                  </Text>
                )}
                {!addsUp && gradingRubricPoints !== undefined && isCapped && (
                  <Text fontSize="sm" mt={1}>
                    The maximum of autograder points ({autograderPoints}) and rubric points ({gradingRubricPoints})
                    exceeds the assignment total ({assignmentMaxPoints}). Consider reducing one or both to fit within
                    the cap.
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
      - description: This is an example of deduction-only scoring. Students start at 0 points
          and can only lose points (down to -total_points). No positive points are ever
          awarded. This is useful for penalty-only grading schemes.
        is_additive: false
        is_deduction_only: true
        name: Deduction-only penalties
        total_points: 20
        checks:
          - name: Late submission
            description: Deduct points for late submissions
            is_annotation: false
            is_required: false
            is_comment_required: false
            points: 5
            student_visibility: always
          - name: Missing required file
            description: Deduct points if required files are missing
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 10
            student_visibility: always
          - name: Code quality violation
            description: Deduct points for code quality issues
            is_annotation: true
            is_required: false
            is_comment_required: true
            max_annotations: 5
            points: 2
            student_visibility: if_applied
is_private: false
`;
