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
import { useDataProvider, useInvalidate } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  clearRubricUnsavedChangesFlag,
  RUBRIC_UNSAVED_CHANGES_WARNING_MESSAGE,
  setRubricUnsavedChangesFlag
} from "@/lib/rubricUnsavedChanges";
import {
  computeRubricPointsBreakdown,
  HydratedRubricToYamlRubric,
  maxPointsForCriterion,
  resolveReferences,
  sanitizeHydratedRubricPoints,
  YamlRubricToHydratedRubric,
  type PointsValidationWarning
} from "@/lib/rubric";
import type { RubricPointsBreakdown } from "@/lib/rubric";
import { RubricGuiEditor, type RubricGuiEditorHandle } from "@/components/rubric-editor";
import { createClient } from "@/utils/supabase/client";

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

const VIEW_MODE_STORAGE_KEY = "pawtograder:rubric-editor:viewMode";

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
    // The inner list-controller hooks return their previous render's array on the first
    // render after a predicate change (state resets via useEffect, not synchronously).
    // On a tab switch, that means we can briefly see (review_round=self-review) paired
    // with (rubric=previous-round's-stale-rubric, parts=that-round's-parts), and emit a
    // hybrid rubric whose review_round is right but whose parts belong to the wrong
    // round. Save then sends a payload labeled self-review but full of grading-review
    // parts, the RPC tries to delete the real self-review parts, and FK constraints on
    // rubric_criteria block it.
    //
    // Two filters defend against that:
    //   1. Bail if rubric.review_round doesn't match the requested round.
    //   2. Drop any parts (and their criteria/checks) whose rubric_id doesn't match.
    if (rubric.review_round !== review_round) return undefined;
    const ownParts = parts.filter((p) => p.rubric_id === rubric.id);

    // Build the hydrated structure
    const hydratedParts: HydratedRubricPart[] = ownParts.map((part) => {
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

  const debounceTimeoutRef = useRef<NodeJS.Timeout>();
  const guiEditorRef = useRef<RubricGuiEditorHandle>(null);
  const pendingGuiRubricRef = useRef<HydratedRubric | null>(null);
  const [guiEditorEpoch, setGuiEditorEpoch] = useState(0);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  /** Set by handleGuiChange so the activeRubric→YAML sync effect does not fight GUI edits. */
  const skipActiveRubricYamlSyncRef = useRef(false);
  const wasRestoredFromStashRef = useRef(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [updatePaused, setUpdatePaused] = useState<boolean>(false);
  const [pointsWarnings, setPointsWarnings] = useState<PointsValidationWarning[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  // Points summary state
  const gradingRubricFromDb = useRubric("grading-review");

  // Get rubric data for points calculation from database (when not in preview mode)
  const gradingRubricCriteria = useRubricCriteriaByRubric(gradingRubricFromDb?.id);
  const gradingRubricChecks = useRubricChecksByRubric(gradingRubricFromDb?.id);

  const assignmentMaxPoints = assignmentDetails?.total_points ?? 0;
  const autograderPoints = assignmentDetails?.autograder_points ?? 0;

  // Breakdown reflects whichever source is the freshest: live editor state when
  // we're on the grading-review tab, else the DB-derived rubric. Both editors
  // (GUI + YAML) feed `rubricForSidebar` so the comparison updates in real time
  // when points, scoring mode, cap, or part mode changes.
  const gradingRubricBreakdown = useMemo<RubricPointsBreakdown | undefined>(() => {
    if (activeReviewRound === "grading-review" && rubricForSidebar) {
      return computeRubricPointsBreakdown(rubricForSidebar);
    }

    if (!gradingRubricFromDb) {
      return { total: 0 } as RubricPointsBreakdown & { total: 0 };
    }
    if (!gradingRubricCriteria || !gradingRubricChecks) return undefined;

    // The DB controllers expose flat lists; the part list isn't memoized here so
    // we approximate the breakdown from criteria + checks alone (i.e. without
    // per-part split-grading info). That's fine because the editor-side
    // breakdown above is what users actually interact with — this branch only
    // covers the initial render before `rubricForSidebar` is populated.
    let total = 0;
    for (const criteria of gradingRubricCriteria) {
      const checksForCriteria = gradingRubricChecks.filter((check) => check.rubric_criteria_id === criteria.id);
      total += maxPointsForCriterion({ ...criteria, rubric_checks: checksForCriteria });
    }
    return {
      total,
      standard: total,
      individual: 0,
      assignToStudentPerStudent: 0,
      assignToStudentTotal: 0,
      assignToStudentParts: [],
      assignToStudentUnbalanced: false
    };
  }, [activeReviewRound, rubricForSidebar, gradingRubricFromDb, gradingRubricCriteria, gradingRubricChecks]);

  const gradingRubricPoints = gradingRubricBreakdown?.total;

  // `cap_score_to_assignment_points` is editable in the rubric header, so prefer
  // the live edited rubric over the saved DB value when we have it.
  const isCapped =
    activeReviewRound === "grading-review" && rubricForSidebar
      ? (rubricForSidebar.cap_score_to_assignment_points ?? false)
      : (gradingRubricFromDb?.cap_score_to_assignment_points ?? false);
  const addsUp =
    gradingRubricPoints !== undefined &&
    (isCapped
      ? Math.max(autograderPoints, gradingRubricPoints) <= assignmentMaxPoints
      : assignmentMaxPoints === autograderPoints + gradingRubricPoints);

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
    // Expose the Monaco namespace for e2e tests that need to read/write YAML directly.
    // No-op in normal use - just a property on window.
    (window as Window & { monaco?: Monaco }).monaco = monaco;
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
        setPointsWarnings([]);
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

          const { rubric: sanitizedRubric, warnings } = sanitizeHydratedRubricPoints(mergedRubric);
          setPointsWarnings(warnings);
          setRubricForSidebar(sanitizedRubric);
          if (warnings.length > 0 && viewModeRef.current === "source") {
            skipActiveRubricYamlSyncRef.current = true;
            setValue(YAML.stringify(HydratedRubricToYamlRubric(sanitizedRubric, { allRubrics: allHydratedRubrics })));
          }
          setError(undefined);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Unknown YAML parsing error");
        }
      }
    },
    [
      activeRubric,
      assignmentDetails,
      assignment_id,
      activeReviewRound,
      createMinimalNewHydratedRubric,
      allHydratedRubrics
    ]
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value) {
        // Monaco stays mounted while hidden; programmatic setValue from GUI sync must not
        // drive YAML debounce / "preview paused" state.
        if (viewModeRef.current === "gui") return;
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

  const applyGuiUnsavedStatus = useCallback(
    (_rubric: HydratedRubric, yamlString: string) => {
      if (!initialActiveRubricSnapshot) {
        const dirty = yamlString.trim() !== "";
        setHasUnsavedChanges(dirty);
        if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: dirty }));
        return;
      }
      const snapshotYaml = YAML.stringify(HydratedRubricToYamlRubric(initialActiveRubricSnapshot));
      const changed = snapshotYaml !== yamlString;
      setHasUnsavedChanges(changed);
      if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: changed }));
    },
    [initialActiveRubricSnapshot, activeReviewRound]
  );

  const syncGuiRubricToYamlAndPreview = useCallback(
    (rubric: HydratedRubric): string => {
      skipActiveRubricYamlSyncRef.current = true;
      const { rubric: sanitized, warnings } = sanitizeHydratedRubricPoints(rubric);
      if (viewModeRef.current === "gui") {
        setPointsWarnings([]);
      } else {
        setPointsWarnings(warnings);
      }
      const yamlString = YAML.stringify(HydratedRubricToYamlRubric(sanitized, { allRubrics: allHydratedRubrics }));
      setValue(yamlString);
      setRubricForSidebar(sanitized);
      applyGuiUnsavedStatus(sanitized, yamlString);
      setUpdatePaused(false);
      return yamlString;
    },
    [allHydratedRubrics, applyGuiUnsavedStatus]
  );

  const flushPendingGuiSync = useCallback((): string => {
    const rubric = guiEditorRef.current?.flushDraft() ?? pendingGuiRubricRef.current ?? activeRubric;
    if (!rubric) return value;
    pendingGuiRubricRef.current = rubric;
    setActiveRubric(rubric);
    return syncGuiRubricToYamlAndPreview(rubric);
  }, [activeRubric, value, syncGuiRubricToYamlAndPreview]);

  const handleGuiDraftActivity = useCallback(
    (rubric: HydratedRubric) => {
      pendingGuiRubricRef.current = rubric;
      setUpdatePaused(true);
      setHasUnsavedChanges(true);
      if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: true }));
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
    },
    [activeReviewRound]
  );

  const handleGuiCommit = useCallback(
    (rubric: HydratedRubric) => {
      skipActiveRubricYamlSyncRef.current = true;
      pendingGuiRubricRef.current = rubric;
      setActiveRubric(rubric);
      setError(undefined);
      syncGuiRubricToYamlAndPreview(rubric);
    },
    [syncGuiRubricToYamlAndPreview]
  );

  const guiReferenceContext = useMemo(
    () => ({
      otherRubrics: allHydratedRubrics.filter((r) => r.review_round !== activeReviewRound),
      unsavedRoundTabs: unsavedStatusPerTab
    }),
    [allHydratedRubrics, activeReviewRound, unsavedStatusPerTab]
  );

  const handleViewModeChange = useCallback(
    (next: "gui" | "source") => {
      if (next === viewMode) return;
      if (next === "gui") {
        if (!value || value.trim() === "") {
          // Empty YAML means the rubric was wiped. Clear the hydrated state too so the GUI
          // doesn't resurrect whatever was previously in activeRubric / rubricForSidebar.
          setActiveRubric(undefined);
          setRubricForSidebar(undefined);
          setError(undefined);
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
          setGuiEditorEpoch((e) => e + 1);
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
        // GUI -> Source: flush debounced YAML so the editor shows the latest GUI edits.
        flushPendingGuiSync();
        persistViewMode("source");
      }
    },
    [
      viewMode,
      value,
      persistViewMode,
      assignment_id,
      activeReviewRound,
      assignmentDetails,
      activeRubric,
      flushPendingGuiSync
    ]
  );

  useEffect(() => {
    if (wasRestoredFromStashRef.current) {
      // Content was from stash, value is already set. Debounced parse might still be needed for sidebar.
      // However, debouncedParseYaml is called in handleReviewRoundChange if restored from stash.
      // Or if activeRubric is set, it's called by the else if block below.
      // For now, if restored from stash, assume value and sidebar are handled.
      return;
    }

    if (activeRubric && !(viewMode === "source" && hasUnsavedChanges)) {
      // In source mode with unsaved YAML edits, activeRubric is stale relative to what the
      // user is typing. Re-serializing it (e.g. on a sibling-rubric refetch) would wipe their
      // in-flight edits.
      if (skipActiveRubricYamlSyncRef.current) {
        skipActiveRubricYamlSyncRef.current = false;
        return;
      }
      const yamlString = YAML.stringify(HydratedRubricToYamlRubric(activeRubric, { allRubrics: allHydratedRubrics }));
      if (yamlString === value) return;
      setValue(yamlString);
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
      // Pass 0 for error markers, as this is a trusted source or new template
      debouncedParseYaml(yamlString, 0);
      setUpdatePaused(false);
    } else if (!activeRubric) {
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
    wasRestoredFromStashRef,
    allHydratedRubrics,
    viewMode,
    hasUnsavedChanges
  ]);

  useEffect(() => {
    if (viewMode === "gui") return;

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
  }, [value, initialActiveRubricSnapshot, activeReviewRound, assignment_id, viewMode]);

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

  const saveRubric = useCallback(
    async (yamlStringValue: string): Promise<string> => {
      if (!assignmentDetails || !activeReviewRound) {
        throw new Error("Cannot save: Missing assignment details or active review round.");
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
        throw new Error(`Invalid YAML: ${(e as Error).message}`);
      }

      // Identify the existing rubric (if any) for this review round; the RPC
      // distinguishes update-vs-create from the `id` field in the payload.
      const { getList } = dataProviderHook();
      const { data: existingRubricQuery } = await getList<HydratedRubric>({
        resource: "rubrics",
        filters: [
          { field: "assignment_id", operator: "eq", value: Number(assignment_id) },
          { field: "review_round", operator: "eq", value: activeReviewRound }
        ],
        pagination: { current: 1, pageSize: 1 }
      });

      const dbRubricForThisRound =
        existingRubricQuery && existingRubricQuery.length > 0 ? existingRubricQuery[0] : undefined;
      const rubricId = dbRubricForThisRound && dbRubricForThisRound.id > 0 ? dbRubricForThisRound.id : 0;

      // Resolve cross-rubric YAML references against the live set of sibling
      // rubrics. We pass the resolved (referencing, referenced) pairs in the
      // payload; the RPC diffs them against existing rows owned by this rubric.
      const otherHydratedRubrics = allHydratedRubrics.filter((r) => r.id !== rubricId);
      const referencesUnsavedNotice: string[] = [];
      const referenceErrors: string[] = [];
      type DesiredRef = { referenced_rubric_check_id: number };
      const refsByPath = new Map<string, DesiredRef[]>();
      const pathKey = (p: number, c: number, k: number) => `${p}.${c}.${k}`;

      // Build a lookup: referenced check id -> its rubric review_round, so we can tell which
      // already-persisted references point at a dirty sibling tab and need to be preserved
      // verbatim (since we can't resolve them against unsaved YAML).
      const roundByCheckId = new Map<number, string | null>();
      for (const rubric of allHydratedRubrics) {
        for (const p of rubric.rubric_parts) {
          for (const cr of p.rubric_criteria) {
            for (const ck of cr.rubric_checks) {
              if (ck.id > 0) roundByCheckId.set(ck.id, rubric.review_round);
            }
          }
        }
      }

      parsedRubricFromEditor.rubric_parts.forEach((part, partIdx) => {
        part.rubric_criteria.forEach((crit, critIdx) => {
          crit.rubric_checks.forEach((check, checkIdx) => {
            const yamlRefs = check.yaml_references;
            const persistedRefs = check.references ?? [];
            // Persisted references whose target lives in a dirty sibling round must survive
            // the save even though we can't re-resolve them from the (stale) YAML.
            const preservedFromDirty: DesiredRef[] = persistedRefs
              .filter((r) => {
                const targetRound = roundByCheckId.get(r.referenced_rubric_check_id);
                return !!targetRound && !!unsavedStatusPerTab[targetRound];
              })
              .map((r) => ({ referenced_rubric_check_id: r.referenced_rubric_check_id }));

            if (yamlRefs && yamlRefs.length > 0) {
              const filteredYamlRefs = yamlRefs.filter((ref) => {
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
                existingReferences: persistedRefs.map((r) => ({
                  id: r.id,
                  referenced_rubric_check_id: r.referenced_rubric_check_id
                }))
              });
              for (const e of errors) referenceErrors.push(`${check.name}: ${e}`);
              // Merge: resolved refs from YAML + any persisted refs pointing at dirty tabs.
              // Dedupe on referenced_rubric_check_id so we don't double-list the same target.
              const merged: DesiredRef[] = [];
              const seen = new Set<number>();
              for (const r of resolved) {
                if (!seen.has(r.referenced_rubric_check_id)) {
                  merged.push({ referenced_rubric_check_id: r.referenced_rubric_check_id });
                  seen.add(r.referenced_rubric_check_id);
                }
              }
              for (const r of preservedFromDirty) {
                if (!seen.has(r.referenced_rubric_check_id)) {
                  merged.push(r);
                  seen.add(r.referenced_rubric_check_id);
                }
              }
              refsByPath.set(pathKey(partIdx, critIdx, checkIdx), merged);
            } else if (persistedRefs.length > 0) {
              // No fresh YAML refs — preserve the already-resolved DB references.
              refsByPath.set(
                pathKey(partIdx, critIdx, checkIdx),
                persistedRefs.map((r) => ({ referenced_rubric_check_id: r.referenced_rubric_check_id }))
              );
            }
          });
        });
      });

      for (const round of Array.from(new Set(referencesUnsavedNotice))) {
        toaster.warning({
          title: "Reference target unsaved",
          description: `Save '${round}' first to finalize the cross-round reference(s).`
        });
      }
      for (const err of referenceErrors) {
        toaster.warning({ title: "Reference not saved", description: err });
      }

      // Build the JSON payload. Keys match `update_rubric_atomic`'s expectations
      // (parts/criteria/checks rather than rubric_parts/rubric_criteria/rubric_checks).
      const payload = {
        id: rubricId,
        class_id: assignmentDetails.class_id,
        assignment_id: Number(assignment_id),
        review_round: activeReviewRound,
        name: parsedRubricFromEditor.name,
        description: parsedRubricFromEditor.description,
        is_private: parsedRubricFromEditor.is_private ?? false,
        cap_score_to_assignment_points: parsedRubricFromEditor.cap_score_to_assignment_points ?? false,
        parts: parsedRubricFromEditor.rubric_parts.map((part, partIdx) => ({
          id: part.id,
          name: part.name,
          description: part.description,
          ordinal: part.ordinal,
          data: part.data,
          is_individual_grading: part.is_individual_grading ?? false,
          is_assign_to_student: part.is_assign_to_student ?? false,
          criteria: part.rubric_criteria.map((crit, critIdx) => ({
            id: crit.id,
            name: crit.name,
            description: crit.description,
            ordinal: crit.ordinal,
            data: crit.data,
            is_additive: crit.is_additive ?? false,
            is_deduction_only: crit.is_deduction_only ?? false,
            total_points: crit.total_points ?? 0,
            max_checks_per_submission: crit.max_checks_per_submission,
            min_checks_per_submission: crit.min_checks_per_submission,
            checks: crit.rubric_checks.map((check, checkIdx) => ({
              id: check.id,
              name: check.name,
              description: check.description,
              ordinal: check.ordinal,
              data: check.data,
              file: check.file,
              artifact: check.artifact,
              group: check.group,
              is_annotation: check.is_annotation,
              is_comment_required: check.is_comment_required,
              is_required: check.is_required,
              max_annotations: check.max_annotations,
              points: check.points,
              annotation_target: check.annotation_target,
              student_visibility: check.student_visibility ?? "always",
              kpi_category: check.kpi_category,
              references: refsByPath.get(pathKey(partIdx, critIdx, checkIdx)) ?? []
            }))
          }))
        }))
      };

      const supabase = createClient();
      const { data, error } = await supabase.rpc("update_rubric_full", {
        p_rubric: payload as never
      });
      if (error) {
        throw new Error(error.message);
      }

      setHasUnsavedChanges(false);
      if (activeReviewRound) setUnsavedStatusPerTab((prev) => ({ ...prev, [activeReviewRound]: false }));
      setStashedEditorStates((prev) => {
        const newState = { ...prev };
        if (activeReviewRound) delete newState[activeReviewRound];
        return newState;
      });

      invalidate({ resource: "assignments", invalidates: ["all"] });
      await refetchCurrentRubric();

      return typeof data === "string" ? data : "Saved rubric.";
    },
    [
      assignmentDetails,
      activeReviewRound,
      dataProviderHook,
      assignment_id,
      refetchCurrentRubric,
      invalidate,
      allHydratedRubrics,
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
    <Flex ref={setRubricPageRootElement} w="100%" minW="0" direction="column" role="region" aria-label="Rubric Editor">
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
                setGuiEditorEpoch((e) => e + 1);
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
                  setGuiEditorEpoch((e) => e + 1);
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
                    setGuiEditorEpoch((e) => e + 1);
                    setInitialActiveRubricSnapshot(JSON.parse(JSON.stringify(minimal)));
                    setValue("");
                  } else {
                    setActiveRubric(undefined);
                    setGuiEditorEpoch((e) => e + 1);
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
                  const yamlToSave = viewMode === "gui" ? flushPendingGuiSync() : value;
                  const summary = await saveRubric(yamlToSave);
                  // Long-lived toast so the instructor has time to read what
                  // changed (including how many submission reviews were
                  // recomputed). The closable meta flag adds an X button so
                  // they can dismiss before the timer expires.
                  toaster.success({
                    title: "Rubric Saved",
                    description: summary,
                    duration: 15000,
                    meta: { closable: true }
                  });
                } catch (error) {
                  Sentry.captureException(error);
                  console.error(error);
                  toaster.error({
                    title: "Failed to save rubric",
                    description:
                      error instanceof Error
                        ? `An unexpected error occurred: ${error.message}`
                        : "An unknown error occurred during the save process.",
                    duration: 15000,
                    meta: { closable: true }
                  });
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
                <Box w="100%" h="calc(100vh - 150px)" overflowY="auto" role="region" aria-label="Rubric GUI">
                  <RubricGuiEditor
                    key={`${activeReviewRound}-${activeRubric.id}-${guiEditorEpoch}`}
                    ref={guiEditorRef}
                    rubric={activeRubric}
                    onCommit={handleGuiCommit}
                    onDraftActivity={handleGuiDraftActivity}
                    assignmentMaxPoints={assignmentMaxPoints}
                    autograderPoints={autograderPoints}
                    referenceContext={guiReferenceContext}
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
                role="region"
                aria-label="Rubric YAML Source"
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
            {updatePaused && (
              <Alert variant="surface" position="sticky" top={0} zIndex={2}>
                Preview paused while typing
              </Alert>
            )}
            {pointsWarnings.length > 0 && viewMode === "source" && (
              <Alert status="warning" variant="surface" title="Points adjusted" mt={2}>
                <VStack gap={1} align="stretch">
                  {pointsWarnings.map((w) => (
                    <Text key={w.path} fontSize="sm">
                      {w.message}
                    </Text>
                  ))}
                </VStack>
              </Alert>
            )}

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
                bg={
                  gradingRubricBreakdown?.assignToStudentUnbalanced ? "bg.warning" : addsUp ? "bg.info" : "bg.warning"
                }
              >
                <Heading size="sm" mb={1}>
                  Grading Rubric Points Summary
                </Heading>
                <Text fontSize="sm" color="fg.muted">
                  The assignment&apos;s max points is set to {assignmentMaxPoints}, and the autograder is currently
                  configured to award up to {autograderPoints} points, and the grading rubric is configured to award{" "}
                  {gradingRubricPoints} points per student. {addsUp && <Icon as={FaCheck} color="fg.success" />}
                </Text>
                {gradingRubricBreakdown &&
                  (gradingRubricBreakdown.individual > 0 || gradingRubricBreakdown.assignToStudentParts.length > 0) && (
                    <Text fontSize="xs" mt={1} color="fg.muted">
                      Per-student total breakdown: {gradingRubricBreakdown.standard} from shared parts
                      {gradingRubricBreakdown.individual > 0 &&
                        ` + ${gradingRubricBreakdown.individual} from individual-grading parts (each student earns independently)`}
                      {gradingRubricBreakdown.assignToStudentParts.length > 0 &&
                        ` + up to ${gradingRubricBreakdown.assignToStudentPerStudent} from assign-to-student parts (assuming each student is assigned at most one of the ${gradingRubricBreakdown.assignToStudentParts.length} such part${gradingRubricBreakdown.assignToStudentParts.length === 1 ? "" : "s"}, ${gradingRubricBreakdown.assignToStudentTotal} points total distributed across the group)`}
                      .
                    </Text>
                  )}
                {gradingRubricBreakdown?.assignToStudentUnbalanced && (
                  <Alert status="warning" variant="surface" mt={2} title="Assign-to-student parts are unbalanced">
                    <Text fontSize="sm">
                      Multiple <code>is_assign_to_student</code> parts have different point totals, so students will
                      have different maxes depending on which part they receive (
                      {gradingRubricBreakdown.assignToStudentParts.map((p) => `${p.name}: ${p.max}`).join(", ")}
                      ). Rebalance them so every student is graded against the same max.
                    </Text>
                  </Alert>
                )}
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
      - description: This is award-per-check scoring with multiple checks. Each check
          has multiple options. Graders must select one option for each check.
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
      - description: This is an example of penalty-only scoring. Students start at 0 points
          and can only lose points (down to -total_points). No positive points are ever
          awarded. This is useful for pure-penalty grading schemes.
        is_additive: false
        is_deduction_only: true
        name: Penalty-only deductions
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
