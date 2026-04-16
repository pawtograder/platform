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
  Code,
  Float,
  Heading,
  HStack,
  Icon,
  Input,
  Link,
  Text,
  VStack
} from "@chakra-ui/react";

import { Alert } from "@/components/ui/alert";
import pluralize from "pluralize";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  if (isEditing && whatIfEnabled) {
    return (
      <Box display="flex" flexDirection="column" alignItems="center">
        <Input
          minW="5em"
          autoFocus
          type="number"
          step="any"
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
          onBlur={() => {
            setIsEditing(false);
            modifiedColumnsRef.current.clear();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setIsEditing(false);
              modifiedColumnsRef.current.clear();
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
  let scoreToShow: string | number | null | undefined = "N/A";
  if (score !== null && score !== undefined) {
    scoreToShow = score;
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
    if (whatIfVal?.what_if !== null && whatIfVal?.what_if !== undefined) {
      scoreToShow = whatIfVal.what_if;
    } else {
      scoreToShow = "0";
    }
  }
  return (
    <HStack flexShrink={0} minW="fit-content" gap={0} pr={2}>
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
        <Box pr={1} minW="fit-content">
          <Text minW="fit-content" fontSize="sm">
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
      {column.render_expression && "("}
      <Text minW="fit-content" fontSize="sm">
        {scoreToShow}
        {column.max_score && `/${column.max_score}`}
      </Text>
      {column.render_expression && ")"}
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
  whatIfEnabled
}: {
  column: GradebookColumn;
  private_profile_id: string;
  isCollapsedGroupItem?: boolean;
  whatIfEnabled: boolean;
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
      <HStack align="top">
        <Card.Header flexGrow={10} p={0}>
          <VStack align="left" maxW="md">
            <Heading size="sm" id={`grade-title-${column.id}`}>
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
        <Card.Body p={0} minW="fit-content">
          <WhatIfScoreCell
            column={column}
            private_profile_id={private_profile_id}
            isEditing={isEditing}
            setIsEditing={setIsEditing}
            whatIfEnabled={whatIfEnabled}
          />
        </Card.Body>
      </HStack>
      <Box id={`grade-description-${column.id}`}>
        <Markdown style={{ fontSize: "0.8rem" }}>{column.description}</Markdown>
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
    <Card.Root
      w="100%"
      bg="bg.subtle"
      cursor="pointer"
      onClick={onToggle}
      borderRadius="none"
      borderBottom="none"
      textAlign="left"
      px={2}
      py={2}
      _hover={{ bg: "bg.info" }}
    >
      <HStack justifyContent="space-between" alignItems="center">
        <HStack gap={2}>
          <Icon as={isCollapsed ? LuChevronRight : LuChevronDown} boxSize={4} color="fg.muted" />
          <Text fontWeight="bold" fontSize="sm" color="fg.muted">
            {columnCount} {pluralize(groupName.charAt(0).toUpperCase() + groupName.slice(1))}...
          </Text>
        </HStack>
      </HStack>
    </Card.Root>
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
    <VStack minW="md" maxW="xl" align="flex-start" role="region" aria-label="Student Gradebook" gap={0}>
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
