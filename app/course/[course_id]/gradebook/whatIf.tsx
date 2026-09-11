import Markdown from "@/components/ui/markdown";
import { Tooltip } from "@/components/ui/tooltip";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useGradebookWhatIfFeatureEnabled } from "@/hooks/useCourseFeatures";
import {
  useGradebookColumn,
  useGradebookColumns,
  useGradebookColumnStudent,
  useGradebookController,
  useLinkToAssignment,
  useSubmissionIDForColumn
} from "@/hooks/useGradebook";
import {
  GradebookWhatIfProvider,
  IncompleteValuesAdvice,
  useGradebookWhatIf,
  useWhatIfGrade
} from "@/hooks/useGradebookWhatIf";
import { GradebookColumn } from "@/utils/supabase/DatabaseTypes";
import {
  Accordion,
  Box,
  Button,
  Card,
  chakra,
  Code,
  Float,
  Heading,
  HStack,
  Icon,
  IconButton,
  Input,
  Link,
  Text,
  VStack
} from "@chakra-ui/react";

import { Alert } from "@/components/ui/alert";
import { SpokenValue } from "@/components/ui/spoken-value";
import pluralize from "pluralize";
import type { CSSProperties, MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Module-stable style — `<Markdown>` is `memo`-wrapped (see
// `components/ui/markdown.tsx`); inline literals defeat it.
const COLUMN_DESCRIPTION_STYLE: CSSProperties = { fontSize: "0.8rem" };
import { FaExclamationTriangle, FaMagic } from "react-icons/fa";
import { FaPencil } from "react-icons/fa6";
import { LuChevronDown, LuChevronRight, LuExternalLink } from "react-icons/lu";

/**
 * Render a grade cell that displays the student's current score, status text, optional rendered expression, and an inline "What If" editor when enabled.
 *
 * @param column - The gradebook column to display; used to determine rendering, max score, and expression output.
 * @param private_profile_id - The student's private profile ID used to fetch their grade and submission status.
 * @param isEditing - When true, the cell shows a numeric input to edit the hypothetical ("What If") grade.
 * @param setIsEditing - Callback to toggle the editing state for this cell.
 *
 * @returns The JSX element representing the score cell, including optional expression rendering, max score, a What If editor, and an instructor override indicator when applicable.
 */
function WhatIfScoreCell({
  column,
  private_profile_id,
  isEditing,
  setIsEditing,
  whatIfEnabled
}: {
  column: GradebookColumn;
  private_profile_id: string;
  isEditing: boolean;
  setIsEditing: (isEditing: boolean) => void;
  whatIfEnabled: boolean;
}) {
  const renderer = useGradebookController().getRendererForColumn(column.id);
  const studentGrade = useGradebookColumnStudent(column.id, private_profile_id);
  const whatIfVal = useWhatIfGrade(column.id);
  const whatIfController = useGradebookWhatIf();
  const score = studentGrade?.score_override ?? studentGrade?.score;
  const submissionStatus = useSubmissionIDForColumn(column.id, private_profile_id);
  const modifiedColumnsRef = useRef(new Set<number>());
  // Editing is user-initiated, so the autoFocus move is legitimate (WCAG 3.2.1);
  // when the editor closes, focus returns to the edit button that opened it.
  const editButtonId = `whatif-edit-${column.id}`;
  const stopEditing = () => {
    setIsEditing(false);
    modifiedColumnsRef.current.clear();
  };
  const closeEditor = () => {
    stopEditing();
    requestAnimationFrame(() => document.getElementById(editButtonId)?.focus());
  };
  if (isEditing && whatIfEnabled) {
    return (
      <Box display="flex" flexDirection="column" alignItems="center">
        <Input
          minW="5em"
          autoFocus
          type="number"
          step="any"
          aria-label={`Hypothetical grade for ${column.name}`}
          value={whatIfVal?.what_if === undefined ? "" : whatIfVal.what_if}
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Number(e.target.value.trim());
            if (v !== undefined) {
              whatIfController.setWhatIfGrade(column.id, v, null);
              modifiedColumnsRef.current.add(column.id);
            } else {
              whatIfController.clearGrade(column.id);
              modifiedColumnsRef.current.delete(column.id);
            }
          }}
          // Blur means focus already moved elsewhere, so close without stealing it back.
          onBlur={stopEditing}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              closeEditor();
            }
          }}
        />
        <Text color="fg.muted">What If?</Text>
        <Text fontSize="sm" color="fg.muted" maxW="xs">
          Simulate your grade based on a hypothetical grade for this item.
        </Text>
      </Box>
    );
  }
  const isShowingWhatIf =
    whatIfEnabled &&
    studentGrade?.score_override == null &&
    whatIfVal?.what_if !== undefined &&
    whatIfVal?.what_if !== null &&
    whatIfVal?.what_if !== score;
  const max_score = column.max_score ?? 100;
  // `hasNumericScore` tracks whether `scoreToShow` is a real point value rather
  // than a status word. The two are rendered very differently: only a number
  // takes the "/max" suffix, and only a number is spoken as "N of M points"
  // (issue #915 — every status used to pick up the suffix, so a submitted-but-
  // ungraded item rendered "Submitted/100" and announced "Submitted slash 100").
  let scoreToShow: string | number = "N/A";
  let hasNumericScore = false;
  if (score !== null && score !== undefined) {
    scoreToShow = score;
    hasNumericScore = true;
  } else if (submissionStatus.status === "no-submission") {
    scoreToShow = "Not Submitted";
  } else if (submissionStatus.status === "found") {
    scoreToShow = "Submitted";
  } else if (studentGrade?.is_missing) {
    scoreToShow = "Missing";
  } else if (studentGrade?.is_excused) {
    scoreToShow = "Excused";
  } else if (!studentGrade?.released) {
    scoreToShow = "In Progress";
  }
  if (isShowingWhatIf) {
    scoreToShow = whatIfVal?.what_if ?? 0;
    hasNumericScore = true;
  }
  const showMaxScore = hasNumericScore && column.max_score != null;
  // Screen readers get the value in words. "5/100" is at best ambiguous read as
  // "5 slash 100"; a status word paired with a max is actively wrong, so the max
  // moves to a "worth N points" clause where it is still available but no longer
  // reads as a fraction of a score the student does not have.
  let spokenScore: string;
  if (hasNumericScore) {
    spokenScore = column.max_score != null ? `${scoreToShow} of ${column.max_score} points` : `${scoreToShow} points`;
  } else {
    spokenScore = column.max_score != null ? `${scoreToShow}, worth ${column.max_score} points` : `${scoreToShow}`;
  }
  return (
    <HStack gap={0} pr={2} flexWrap="wrap" justifyContent="flex-end">
      {studentGrade?.score_override != null && studentGrade?.released && (
        <Tooltip
          content={`This value is overridden by an instructor, and does not reflect the calculated value. If you have a concern, please contact the instructor.${studentGrade?.score_override_note ? ` Note from instructor: ${studentGrade.score_override_note}` : ""}`}
        >
          <Float placement="top-end" offset={2}>
            <Icon as={FaPencil} color="fg.warning" size="xs" />
          </Float>
        </Tooltip>
      )}
      {column.render_expression && (
        <Box pr={1}>
          <Text fontSize="sm">
            {" "}
            {renderer(
              isShowingWhatIf
                ? {
                    score: whatIfVal?.what_if ?? null,
                    score_override: null,
                    is_missing: false,
                    is_excused: false,
                    is_droppable: false,
                    released: false,
                    max_score: max_score
                  }
                : studentGrade
                  ? { ...studentGrade, max_score }
                  : {
                      score: null,
                      score_override: null,
                      is_missing: false,
                      is_excused: false,
                      is_droppable: false,
                      released: false,
                      max_score: max_score
                    }
            )}
          </Text>
        </Box>
      )}
      {/* Punctuation that only groups the rendered expression with the raw
          score visually — spoken it is just "left paren" noise, and the
          SpokenValue below already reads the score as a phrase. */}
      {column.render_expression && <chakra.span aria-hidden="true">(</chakra.span>}
      <Text fontSize="sm" whiteSpace="nowrap">
        <SpokenValue spoken={spokenScore}>
          {scoreToShow}
          {showMaxScore && `/${column.max_score}`}
        </SpokenValue>
      </Text>
      {column.render_expression && <chakra.span aria-hidden="true">)</chakra.span>}
      {whatIfEnabled && canEditColumn(column) && (
        // Keyboard path into what-if editing (WCAG 2.1.1): the card-level click
        // handler is a pointer convenience; this button is the operable control.
        <IconButton
          id={editButtonId}
          aria-label={`Edit hypothetical grade for ${column.name}`}
          size="2xs"
          variant="ghost"
          ml={1}
          onClick={() => setIsEditing(true)}
        >
          <Icon as={FaMagic} aria-hidden="true" />
        </IconButton>
      )}
    </HStack>
  );
}

function canEditColumn(column: GradebookColumn) {
  const deps = column.dependencies;
  return !(
    deps &&
    typeof deps === "object" &&
    "gradebook_columns" in deps &&
    Array.isArray((deps as { gradebook_columns?: number[] }).gradebook_columns) &&
    (deps as { gradebook_columns?: number[] }).gradebook_columns!.length > 0
  );
}

function IncompleteValuesAlert({
  incompleteValues,
  column_id
}: {
  incompleteValues: IncompleteValuesAdvice;
  column_id: number;
}) {
  const grade = useWhatIfGrade(column_id);
  const report_only = grade?.report_only;
  const controller = useGradebookController();
  const slugToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of controller.columns) {
      if (col.slug && col.name) map.set(col.slug, col.name);
    }
    return map;
  }, [controller.columns]);
  const resolveNames = useCallback(
    (slugs: string[] | undefined) => slugs?.map((s) => slugToName.get(s) ?? s),
    [slugToName]
  );
  const missingGradebookColumns = resolveNames(incompleteValues.missing?.gradebook_columns);
  const notReleasedGradebookColumns = resolveNames(incompleteValues.not_released?.gradebook_columns);
  const column = useGradebookColumn(column_id);
  const hasRenderExpr = column.render_expression !== null;
  const renderer = controller.getRendererForColumn(column_id);
  const maxGrade = useMemo(() => {
    if (grade?.assume_max !== undefined && renderer && hasRenderExpr) {
      return renderer({
        score: grade.assume_max,
        score_override: null,
        is_missing: false,
        is_excused: false,
        is_droppable: false,
        released: false,
        max_score: column.max_score ?? 100
      });
    }
    return undefined;
  }, [renderer, grade?.assume_max, column.max_score, hasRenderExpr]);
  const minGrade = useMemo(() => {
    if (grade?.assume_zero !== undefined && renderer && hasRenderExpr) {
      return renderer({
        score: grade.assume_zero,
        score_override: null,
        is_missing: false,
        is_excused: false,
        is_droppable: false,
        released: false,
        max_score: column.max_score ?? 100
      });
    }
    return undefined;
  }, [renderer, grade?.assume_zero, column.max_score, hasRenderExpr]);
  return (
    <Accordion.Root collapsible defaultValue={[]}>
      <Accordion.Item value="incomplete-values">
        <Accordion.ItemTrigger bg="bg.info" borderRadius="md" py={1}>
          <HStack gap={2} pl={2} justifyContent="space-between" w="100%">
            <HStack gap={2}>
              <Icon fontSize="sm" as={FaExclamationTriangle} color="fg.info" />
              <Text fontSize="sm">Incomplete Values</Text>
            </HStack>
            <Accordion.ItemIndicator>
              <Icon as={LuChevronDown} />
            </Accordion.ItemIndicator>
          </HStack>
        </Accordion.ItemTrigger>
        <Accordion.ItemContent>
          <Accordion.ItemBody>
            <Alert variant="subtle" title="Incomplete Values" zIndex={1}>
              <Text fontSize="sm">This value can not be fully calculated right now.</Text>
              {false && column.show_calculated_ranges && (
                <Text fontSize="sm">
                  The score <Code variant="surface">{report_only}</Code> only considers values that have been graded.
                  Assuming full marks for the missing items, the best possible value is{" "}
                  <Code variant="surface">{grade?.assume_max}</Code> {maxGrade ? `(${maxGrade})` : ""} and assuming
                  existing marks remain as they are, the worst possible value is{" "}
                  <Code variant="surface">{grade?.assume_zero}</Code> {minGrade ? `(${minGrade})` : ""}.
                </Text>
              )}
              <Box>
                <Text fontSize="sm">The current score will change when these grades are available:</Text>
                {missingGradebookColumns && <Text fontSize="sm">Missing: {missingGradebookColumns.join(", ")}</Text>}
                {notReleasedGradebookColumns && (
                  <Text fontSize="sm">Not graded: {notReleasedGradebookColumns.join(", ")}</Text>
                )}
              </Box>
            </Alert>
          </Accordion.ItemBody>
        </Accordion.ItemContent>
      </Accordion.Item>
    </Accordion.Root>
  );
}

export default function WhatIfPage() {
  const { private_profile_id } = useClassProfiles();
  const whatIfEnabled = useGradebookWhatIfFeatureEnabled();
  return (
    <GradebookWhatIfProvider private_profile_id={private_profile_id}>
      <WhatIf private_profile_id={private_profile_id} whatIfEnabled={whatIfEnabled} />
    </GradebookWhatIfProvider>
  );
}

function GradebookCard({
  column,
  private_profile_id,
  isCollapsedGroupItem = false,
  whatIfEnabled,
  // A column inside a group sits under that group's <h2>, so it is an h3;
  // an ungrouped column is a direct child of the page's h1 and stays an h2.
  // Keeping this honest matters for heading navigation — a fixed level would
  // either skip h2 or flatten the group relationship away (WCAG 1.3.1).
  headingLevel = 2
}: {
  column: GradebookColumn;
  private_profile_id: string;
  isCollapsedGroupItem?: boolean;
  whatIfEnabled: boolean;
  headingLevel?: 2 | 3;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const whatIfVal = useWhatIfGrade(column.id);
  const studentGrade = useGradebookColumnStudent(column.id, private_profile_id);
  const score = studentGrade?.score_override ?? studentGrade?.score;
  const isShowingWhatIf =
    whatIfEnabled &&
    studentGrade?.score_override == null &&
    whatIfVal?.what_if !== undefined &&
    whatIfVal?.what_if !== null &&
    whatIfVal?.what_if !== score;
  const canEdit = whatIfEnabled && canEditColumn(column);
  const whatIfController = useGradebookWhatIf();
  const whatIfIncompleteValues = whatIfController.getIncompleteValues(column.id);
  const incompleteValues = whatIfIncompleteValues ?? studentGrade?.incomplete_values;
  const hasIncompleteValues = incompleteValues && Object.keys(incompleteValues).length > 0;
  const linkToAssignment = useLinkToAssignment(column.id, private_profile_id);

  return (
    <Card.Root
      key={column.id}
      role="article"
      aria-label={`Grade for ${column.name}`}
      aria-describedby={`grade-description-${column.id}`}
      w={isCollapsedGroupItem ? "calc(100% - 1rem)" : "100%"}
      bg={isShowingWhatIf ? "bg.info" : undefined}
      justifyContent="space-between"
      cursor={canEdit ? "pointer" : "default"}
      display="flex"
      onClick={
        canEdit
          ? (e: MouseEvent<HTMLDivElement>) => {
              const target = e.target as HTMLElement;
              if (target.closest("a, button, input, textarea, select, [role='link']")) {
                return;
              }
              setIsEditing(true);
            }
          : undefined
      }
      borderRadius="none"
      borderBottom="none"
      textAlign="left"
      px={2}
      py={1}
      ml={isCollapsedGroupItem ? 4 : 0}
      borderLeft={isCollapsedGroupItem ? "3px solid" : undefined}
      borderLeftColor={isCollapsedGroupItem ? "border.muted" : undefined}
    >
      {isShowingWhatIf && (
        <Tooltip content='This value is hypothetical, based on the current "What If?" simulation.'>
          <Float placement="top-end" offset={2}>
            <Icon as={FaMagic} color="blue.500" size="xs" />
          </Float>
        </Tooltip>
      )}
      <HStack align="start" flexWrap="wrap" gap={2} w="100%">
        <Card.Header flexGrow={10} minW={0} p={0}>
          <VStack align="start" w="100%">
            <Heading as={headingLevel === 3 ? "h3" : "h2"} size="sm" id={`grade-title-${column.id}`}>
              {column.name}
            </Heading>
            {linkToAssignment && (
              <Link
                ml={2}
                fontSize="sm"
                href={linkToAssignment}
                target="_blank"
                aria-label={`View submission for ${column.name}`}
              >
                <Icon as={LuExternalLink} /> View Submission
              </Link>
            )}
          </VStack>
        </Card.Header>
        <Card.Body p={0}>
          <WhatIfScoreCell
            column={column}
            private_profile_id={private_profile_id}
            isEditing={isEditing}
            setIsEditing={setIsEditing}
            whatIfEnabled={whatIfEnabled}
          />
        </Card.Body>
      </HStack>
      <Box id={`grade-description-${column.id}`} overflowWrap="anywhere" w="100%">
        <Markdown style={COLUMN_DESCRIPTION_STYLE}>{column.description}</Markdown>
      </Box>
      {hasIncompleteValues && (
        <IncompleteValuesAlert incompleteValues={incompleteValues as IncompleteValuesAdvice} column_id={column.id} />
      )}
    </Card.Root>
  );
}
function GroupHeader({
  groupName,
  columnCount,
  isCollapsed,
  onToggle
}: {
  groupName: string;
  columnCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    // The group name is a heading as well as a control (WCAG 1.3.1): it labels
    // the block of columns beneath it, so heading navigation has to be able to
    // reach it. As a bare <button> it was invisible to heading nav, leaving a
    // grouped gradebook with no reachable structure between the h1 and the
    // individual columns. <h2><button> is the standard disclosure pattern —
    // the heading carries the structure, the button carries the operability.
    // fontSize/fontWeight inherit so this stays visually identical.
    <chakra.h2 w="100%" m={0} fontSize="inherit" fontWeight="inherit">
      {/* A real <button> (WCAG 2.1.1/4.1.2): keyboard focusable/operable with the
          expanded state announced — the clickable-div version locked keyboard users
          out of expanding gradebook groups entirely. type="button" pins the default
          away from type=submit so a form ancestor never treats toggling as a submit. */}
      <Card.Root
        asChild
        w="100%"
        bg="bg.subtle"
        cursor="pointer"
        borderRadius="none"
        borderBottom="none"
        textAlign="left"
        px={2}
        py={2}
        _hover={{ bg: "bg.info" }}
      >
        <button type="button" aria-expanded={!isCollapsed} onClick={onToggle}>
          {/* Buttons only permit phrasing content, so the layout wrappers render as spans. */}
          <HStack as="span" justifyContent="space-between" alignItems="center">
            <HStack as="span" gap={2}>
              <Icon as={isCollapsed ? LuChevronRight : LuChevronDown} boxSize={4} color="fg.muted" aria-hidden="true" />
              <Text as="span" fontWeight="bold" fontSize="sm" color="fg.muted">
                {columnCount} {pluralize(groupName.charAt(0).toUpperCase() + groupName.slice(1))}...
              </Text>
            </HStack>
          </HStack>
        </button>
      </Card.Root>
    </chakra.h2>
  );
}

function CollapsedGroupColumn({
  groupColumns,
  private_profile_id,
  whatIfEnabled
}: {
  groupColumns: GradebookColumn[];
  private_profile_id: string;
  whatIfEnabled: boolean;
}) {
  // For now, let's use a simpler approach that checks just the first and last columns
  // to avoid React hooks rule violations with dynamic loops
  const firstGrade = useGradebookColumnStudent(groupColumns[0].id, private_profile_id);
  const lastGrade = useGradebookColumnStudent(
    groupColumns.length > 1 ? groupColumns[groupColumns.length - 1].id : groupColumns[0].id,
    private_profile_id
  );

  // Determine which column to show: first if no grades anywhere, otherwise last
  const selectedColumn = useMemo(() => {
    // Check if any of the checked columns have grades
    const firstScore = firstGrade?.score_override ?? firstGrade?.score;
    const lastScore = lastGrade?.score_override ?? lastGrade?.score;

    const hasFirstGrade = firstScore !== null && firstScore !== undefined;
    const hasLastGrade = lastScore !== null && lastScore !== undefined;

    // If either has a grade, show the last column (preferred when grades exist)
    if (hasFirstGrade || hasLastGrade) {
      return groupColumns[groupColumns.length - 1];
    }

    // No grades found in sampled columns, show first column
    return groupColumns[0];
  }, [groupColumns, firstGrade, lastGrade]);

  return (
    <GradebookCard
      key={selectedColumn.id}
      column={selectedColumn}
      private_profile_id={private_profile_id}
      isCollapsedGroupItem={true}
      whatIfEnabled={whatIfEnabled}
      headingLevel={3}
    />
  );
}

export function WhatIf({ private_profile_id, whatIfEnabled }: { private_profile_id: string; whatIfEnabled: boolean }) {
  const columns = useGradebookColumns();

  // State for collapsible groups - use base group name as key for stability
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Sort columns by sort order
  const sortedColumns = useMemo(() => {
    const cols = [...columns];
    cols.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    return cols;
  }, [columns]);

  // Group gradebook columns by slug prefix, with special handling for assignment sub-groups
  const groupedColumns = useMemo(() => {
    const groups: Record<string, { groupName: string; columns: GradebookColumn[] }> = {};

    let currentGroupKey = "";
    let currentGroupIndex = 0;
    let lastSortOrder = -1;

    sortedColumns.forEach((col) => {
      const slugParts = col.slug.split("-");
      let baseGroupName: string;

      // Special handling for assignment columns
      if (slugParts[0] === "assignment" && slugParts.length >= 3) {
        // For assignment-assignment-*, assignment-lab-*, etc., use "assignment-{type}" as the base group
        baseGroupName = `${slugParts[0]}-${slugParts[1]}`;
      } else {
        // For all other columns, use the first part as the base group
        baseGroupName = slugParts[0] || "other";
      }

      // Check if this column is contiguous with the previous one
      const currentSortOrder = col.sort_order ?? 0;
      const isContiguous = lastSortOrder === -1 || currentSortOrder === lastSortOrder + 1;

      // If not contiguous or different prefix, start a new group
      if (!isContiguous || baseGroupName !== currentGroupKey) {
        currentGroupKey = baseGroupName;
        currentGroupIndex++;
      }

      const groupKey = `${baseGroupName}-${currentGroupIndex}`;

      if (!groups[groupKey]) {
        // Format group name for display
        let displayName: string;
        if (baseGroupName === "other") {
          displayName = "Other";
        } else if (baseGroupName.startsWith("assignment-")) {
          // For assignment sub-groups, capitalize and format nicely
          const subType = baseGroupName.split("-")[1];
          displayName = `${subType.charAt(0).toUpperCase() + subType.slice(1)}`;
        } else {
          displayName = baseGroupName.charAt(0).toUpperCase() + baseGroupName.slice(1);
        }

        groups[groupKey] = {
          groupName: displayName,
          columns: []
        };
      }

      groups[groupKey].columns.push(col);
      lastSortOrder = currentSortOrder;
    });

    return groups;
  }, [sortedColumns]);

  // Initialize all groups as collapsed by default, but preserve existing collapsed state
  useEffect(() => {
    const allGroupKeys = Object.keys(groupedColumns).filter((key) => groupedColumns[key].columns.length > 1);
    const baseGroupNames = [...new Set(allGroupKeys.map((key) => groupedColumns[key].groupName))];

    setCollapsedGroups((prev) => {
      const newSet = new Set<string>();

      // Preserve existing collapsed state for groups that still exist
      baseGroupNames.forEach((baseGroupName) => {
        if (prev.has(baseGroupName)) {
          newSet.add(baseGroupName);
        }
      });

      // If no groups were previously collapsed, collapse all by default
      if (newSet.size === 0 && baseGroupNames.length > 0) {
        baseGroupNames.forEach((baseGroupName) => newSet.add(baseGroupName));
      }

      return newSet;
    });
  }, [groupedColumns]);

  // Toggle group collapse/expand using base group name
  const toggleGroup = useCallback((baseGroupName: string) => {
    setCollapsedGroups((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(baseGroupName)) {
        newSet.delete(baseGroupName);
      } else {
        newSet.add(baseGroupName);
      }
      return newSet;
    });
  }, []);

  // Expand all groups
  const expandAll = useCallback(() => {
    setCollapsedGroups(new Set());
  }, []);

  // Collapse all groups
  const collapseAll = useCallback(() => {
    const allGroupKeys = Object.keys(groupedColumns).filter((key) => groupedColumns[key].columns.length > 1);
    const baseGroupNames = [...new Set(allGroupKeys.map((key) => groupedColumns[key].groupName))];
    setCollapsedGroups(new Set(baseGroupNames));
  }, [groupedColumns]);

  // Build the rendered items
  const renderedItems = useMemo(() => {
    const items: JSX.Element[] = [];

    Object.entries(groupedColumns).forEach(([groupKey, group]) => {
      if (group.columns.length === 1) {
        // Single column - no need for group header
        const column = group.columns[0];
        items.push(
          <GradebookCard
            key={column.id}
            column={column}
            private_profile_id={private_profile_id}
            whatIfEnabled={whatIfEnabled}
          />
        );
      } else {
        // Multiple columns - handle collapsed state using base group name
        const isCollapsed = collapsedGroups.has(group.groupName);

        // Add group header
        items.push(
          <GroupHeader
            key={`header-${groupKey}`}
            groupName={group.groupName}
            columnCount={group.columns.length}
            isCollapsed={isCollapsed}
            onToggle={() => toggleGroup(group.groupName)}
          />
        );

        if (!isCollapsed) {
          // Show all columns when expanded
          group.columns.forEach((column) => {
            items.push(
              <GradebookCard
                key={column.id}
                column={column}
                private_profile_id={private_profile_id}
                whatIfEnabled={whatIfEnabled}
                headingLevel={3}
              />
            );
          });
        } else {
          // Show the appropriate column when collapsed (first if no grades, last if grades exist)
          items.push(
            <CollapsedGroupColumn
              key={`collapsed-${groupKey}`}
              groupColumns={group.columns}
              private_profile_id={private_profile_id}
              whatIfEnabled={whatIfEnabled}
            />
          );
        }
      }
    });

    return items;
  }, [groupedColumns, collapsedGroups, toggleGroup, private_profile_id, whatIfEnabled]);

  return (
    <VStack w="100%" maxW="3xl" align="flex-start" role="region" aria-label="Student Gradebook" gap={0}>
      {!whatIfEnabled && (
        <Text fontSize="sm" color="fg.muted" px={2} py={2} w="100%">
          Grade simulations (What If) are not enabled for this course. You can still view released grades below.
        </Text>
      )}
      {/* Expand/Collapse All Buttons */}
      {Object.keys(groupedColumns).filter((key) => groupedColumns[key].columns.length > 1).length > 0 && (
        <HStack gap={2} justifyContent="flex-end" w="100%" px={2} py={2}>
          <Button variant="ghost" size="sm" onClick={expandAll} colorPalette="blue">
            <Icon as={LuChevronDown} mr={2} /> Expand All
          </Button>
          <Button variant="ghost" size="sm" onClick={collapseAll} colorPalette="blue">
            <Icon as={LuChevronRight} mr={2} /> Collapse All
          </Button>
        </HStack>
      )}
      {renderedItems}
    </VStack>
  );
}
