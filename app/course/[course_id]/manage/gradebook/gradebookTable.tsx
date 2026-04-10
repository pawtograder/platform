"use client";

import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import PersonName from "@/components/ui/person-name";
import { Toaster, toaster } from "@/components/ui/toaster";
import { Tooltip as WrappedTooltip } from "@/components/ui/tooltip";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import {
  useAllStudentRoles,
  useCanShowGradeFor,
  useCourseController,
  useObfuscatedGradesMode,
  useSetOnlyShowGradesFor
} from "@/hooks/useCourseController";
import {
  useAreAllDependenciesReleased,
  useGradebookColumn,
  useGradebookColumnGrades,
  useGradebookColumns,
  useGradebookController,
  useGradebookRefetchStatus,
  useIsGradebookDataReady,
  useStudentDetailView
} from "@/hooks/useGradebook";
import { GradebookWhatIfProvider } from "@/hooks/useGradebookWhatIf";
import { createClient } from "@/utils/supabase/client";
import {
  ClassSection,
  GradebookColumn,
  GradebookColumnExternalData,
  GradebookColumnStudent,
  LabSection,
  UserProfile
} from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  Code,
  Dialog,
  HStack,
  Icon,
  IconButton,
  Input,
  Link,
  List,
  PopoverBody,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Portal,
  Spinner,
  Table,
  Text,
  Textarea,
  Tooltip,
  VStack
} from "@chakra-ui/react";
import { useList, useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import {
  Column,
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  Header,
  RowModel,
  useReactTable,
  type Column as TanStackColumn
} from "@tanstack/react-table";
import { useVirtualizer, VirtualItem } from "@tanstack/react-virtual";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { Select } from "chakra-react-select";
import { LucideInfo } from "lucide-react";
import { useParams } from "next/navigation";
import pluralize from "pluralize";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FieldValues } from "react-hook-form";
import { FaLock } from "react-icons/fa";
import { FaLockOpen } from "react-icons/fa6";
import { FiChevronDown, FiDownload, FiFilter, FiPlus } from "react-icons/fi";
import {
  LuArrowDown,
  LuArrowLeft,
  LuArrowRight,
  LuArrowUp,
  LuCalculator,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuFile,
  LuGripVertical,
  LuLayoutGrid,
  LuPencil,
  LuTrash,
  LuX
} from "react-icons/lu";
import { TbEye, TbEyeOff, TbFilter } from "react-icons/tb";
import { WhatIf } from "../../gradebook/whatIf";
import GradebookCell from "./gradebookCell";
import { GradebookPopoverProvider, useGradebookPopover } from "./GradebookPopoverProvider";
import ImportGradebookColumn from "./importGradebookColumn";

const GRADE_COL_WIDTH = 120;

/** Line clamp for gradebook column header titles (see GradebookColumnHeader / GenericGradebookColumnHeader). */
const GRADE_HEADER_MAX_TITLE_LINES = 2;

/** Used by measureMaxHeaderHeight to approximate toolbar + status rows under the title. */
const GRADE_HEADER_TOOLBAR_ROW_PX = 22;
const GRADE_HEADER_STATUS_ROW_PX = 22;
const GRADE_HEADER_VERTICAL_PADDING_EXTRA_PX = 16;

/**
 * Pre-measure max leaf header height for all grade columns (full-width title layout + line clamp).
 * Avoids per-render DOM walks and viewport-only measurement when columns are virtualized horizontally.
 */
function measureMaxGradeHeaderHeight(columnNames: string[], colWidth: number, maxLines: number): number {
  if (typeof document === "undefined") return 48;
  if (columnNames.length === 0) return 48;

  const container = document.createElement("div");
  container.style.cssText = [
    "position:absolute",
    "visibility:hidden",
    "pointer-events:none",
    `width:${colWidth}px`,
    "padding:8px",
    "box-sizing:border-box",
    "font-size:14px",
    "font-weight:600",
    "line-height:1.25",
    "font-family:inherit"
  ].join(";");

  const textEl = document.createElement("div");
  textEl.style.cssText = [
    "display:-webkit-box",
    `-webkit-line-clamp:${maxLines}`,
    "-webkit-box-orient:vertical",
    "overflow:hidden",
    "word-break:break-word"
  ].join(";");

  container.appendChild(textEl);
  document.body.appendChild(container);

  let maxTextH = 0;
  for (const name of columnNames) {
    textEl.textContent = name;
    maxTextH = Math.max(maxTextH, textEl.offsetHeight);
  }

  document.body.removeChild(container);

  const totalH =
    GRADE_HEADER_TOOLBAR_ROW_PX + maxTextH + GRADE_HEADER_STATUS_ROW_PX + GRADE_HEADER_VERTICAL_PADDING_EXTRA_PX;
  return Math.max(totalH, 48);
}

const GRADEBOOK_GAP_PREFIX = "gradebook-gap-";

/** Joins raw score strings when a bucketed renderer maps multiple scores to one filter label. */
const GRADEBOOK_SCORE_FILTER_GROUP_SEP = ",";

function parseGradebookEntryScore(
  scoreOverride: number | null | undefined,
  score: number | null | undefined
): number | null {
  const raw = scoreOverride ?? score;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Aligns map values with filter tokens built from `String(score ?? "")` in the column filter UI. */
function gradebookScoreToFilterRawString(value: number | null): string {
  return value === null ? "" : String(value);
}

function compareGradeColumnSortValues(a: unknown, b: unknown): number {
  const na = typeof a === "number" && Number.isFinite(a) ? a : null;
  const nb = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (na === null && nb === null) return 0;
  if (na === null) return 1;
  if (nb === null) return -1;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

function gradebookScoreFilterMatches(filterValue: unknown, cellRaw: string): boolean {
  if (!filterValue) return true;
  const selected = Array.isArray(filterValue) ? filterValue : [filterValue];
  for (const token of selected) {
    if (typeof token !== "string") continue;
    const raws = token.includes(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
      ? token.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
      : [token];
    if (raws.includes(cellRaw)) return true;
  }
  return false;
}

/** Shape of `groupedColumns[*].columns` (matches `columnsForGrouping` entries). */
type GradebookGroupedColumnRef = {
  id: number;
  slug: GradebookColumn["slug"];
  sort_order: GradebookColumn["sort_order"];
  name: GradebookColumn["name"];
  max_score: GradebookColumn["max_score"];
};

/** Build left-to-right "units": each is a block of DB column ids. Collapsed groups = one unit (whole group). */
function buildVisibleReorderUnits(args: {
  scrollableLeafColumns: TanStackColumn<UserProfile, unknown>[];
  groupedColumns: Record<string, { groupName: string; columns: GradebookGroupedColumnRef[] }>;
  collapsedGroups: Set<string>;
  findBestColumnToShow: (columns: GradebookGroupedColumnRef[]) => GradebookGroupedColumnRef;
  gradebookColumns: { id: number; slug: string | null }[];
}): number[][] {
  const { scrollableLeafColumns, groupedColumns, collapsedGroups, findBestColumnToShow, gradebookColumns } = args;
  const units: number[][] = [];
  for (const leaf of scrollableLeafColumns) {
    if (!String(leaf.id).startsWith("grade_")) continue;
    const colId = Number(String(leaf.id).slice(6));
    const col = gradebookColumns.find((c) => c.id === colId);
    if (!col?.slug) {
      units.push([colId]);
      continue;
    }
    const slugParts = col.slug.split("-");
    let baseGroupName: string;
    if (slugParts[0] === "assignment" && slugParts.length >= 3) {
      baseGroupName = `${slugParts[0]}-${slugParts[1]}`;
    } else {
      baseGroupName = slugParts[0] || "other";
    }
    const groupEntry = Object.entries(groupedColumns).find(
      ([key, group]) => key.startsWith(baseGroupName) && group.columns.some((c) => c.id === colId)
    );
    if (!groupEntry || groupEntry[1].columns.length <= 1) {
      units.push([colId]);
      continue;
    }
    const group = groupEntry[1];
    const collapsed = collapsedGroups.has(group.groupName);
    if (collapsed) {
      const best = findBestColumnToShow(group.columns);
      if (colId !== best.id) continue;
      const ids = [...group.columns].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((c) => c.id);
      units.push(ids);
    } else {
      units.push([colId]);
    }
  }
  return units;
}

/** Move the dragged column's visible reorder unit (one id or a collapsed group) to the gap before unit `gapIndex` (or after all if gapIndex === units.length). Intra-unit order matches `fullOrder`. */
function insertColumnAtGap(
  fullOrder: number[],
  draggedColumnId: number,
  units: number[][],
  gapIndex: number
): number[] {
  let sourceUnitIdx = -1;
  for (let i = 0; i < units.length; i++) {
    if (units[i].includes(draggedColumnId)) {
      sourceUnitIdx = i;
      break;
    }
  }
  if (sourceUnitIdx === -1) {
    const without = fullOrder.filter((id) => id !== draggedColumnId);
    if (gapIndex >= units.length) {
      return [...without, draggedColumnId];
    }
    const anchor = units[gapIndex][0];
    const idx = without.indexOf(anchor);
    if (idx === -1) {
      return [...without, draggedColumnId];
    }
    return [...without.slice(0, idx), draggedColumnId, ...without.slice(idx)];
  }

  const unitIdSet = new Set(units[sourceUnitIdx]);
  const block = fullOrder.filter((id) => unitIdSet.has(id));
  const without = fullOrder.filter((id) => !unitIdSet.has(id));

  if (gapIndex >= units.length) {
    return [...without, ...block];
  }

  const anchor = units[gapIndex][0];
  const idx = without.indexOf(anchor);
  if (idx === -1) {
    // Dropping on the gap before this unit: anchor is inside the moved block (same visible unit).
    if (gapIndex === sourceUnitIdx) {
      return fullOrder.slice();
    }
    return [...without, ...block];
  }
  return [...without.slice(0, idx), ...block, ...without.slice(idx)];
}

const MemoizedGradebookCell = React.memo(GradebookCell);

const GradebookPointerOpener = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof Box>>(
  function GradebookPointerOpener({ children, ...rest }, ref) {
    const { openAt } = useGradebookPopover();
    const onPointerDownCapture = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        const el = (e.target as HTMLElement).closest("[data-gradebook-cell-trigger]");
        if (!el || !(el instanceof HTMLElement)) return;
        const columnId = el.getAttribute("data-column-id");
        const studentId = el.getAttribute("data-student-id");
        if (columnId == null || studentId == null) return;
        e.preventDefault();
        e.stopPropagation();
        openAt({ targetElement: el, columnId: Number(columnId), studentId });
      },
      [openAt]
    );
    return (
      <Box ref={ref} onPointerDownCapture={onPointerDownCapture} {...rest}>
        {children}
      </Box>
    );
  }
);

function RenderExprDocs() {
  return (
    <Text fontSize="sm" color="fg.muted">
      Refers to the score as variable <Code>score</Code>. Convert to letter with <Code>letter(score)</Code>
      <Link
        href="https://docs.pawtograder.com/staff/gradebook#gradebook-expression-syntax-documentation"
        target="_blank"
        colorPalette="green"
      >
        Read the docs
      </Link>
    </Text>
  );
}
function ScoreExprDocs() {
  return (
    <Text fontSize="sm" color="fg.muted">
      Reference a gradebook column or assignment with <Code>gradebook_columns(&quot;slug&quot;)</Code>, globs supported.{" "}
      <Link
        href="https://docs.pawtograder.com/staff/gradebook#gradebook-expression-syntax-documentation"
        target="_blank"
        colorPalette="green"
      >
        Read the docs
      </Link>
    </Text>
  );
}
function AddColumnDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const gradebookController = useGradebookController();

  const [isLoading, setIsLoading] = useState(false);
  const onClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  type FormValues = {
    name: string;
    description?: string;
    maxScore: number;
    slug: string;
    scoreExpression?: string;
    renderExpression?: string;
    instructorOnly: boolean;
  };

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors }
  } = useForm<FormValues>({
    defaultValues: {
      name: "",
      description: "",
      maxScore: 0,
      slug: "",
      scoreExpression: "",
      renderExpression: "",
      instructorOnly: false
    }
  });
  const addColumnScoreExpr = watch("scoreExpression");

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (!isOpen) {
      reset();
    }
  }, [isOpen, reset]);

  const onSubmit = async (data: FieldValues) => {
    setIsLoading(true);
    try {
      const dependencies = gradebookController.extractAndValidateDependencies(data.scoreExpression ?? "", -1);
      await gradebookController.gradebook_columns.create({
        name: data.name,
        description: data.description,
        max_score: data.maxScore,
        slug: data.slug,
        score_expression: data.scoreExpression?.length ? data.scoreExpression : null,
        render_expression: data.renderExpression?.length ? data.renderExpression : null,
        instructor_only: Boolean(data.instructorOnly),
        dependencies,
        class_id: gradebookController.class_id,
        gradebook_id: gradebookController.gradebook_id,
        sort_order: gradebookController.gradebook_columns.rows.length
      });

      setIsLoading(false);
      toaster.create({
        title: "Success",
        description: "Column created successfully",
        type: "success"
      });
      setIsOpen(false);
    } catch (e) {
      setIsLoading(false);
      toaster.dismiss();
      let message = "An unknown error occurred";
      if (e && typeof e === "object" && "message" in e && typeof (e as { message?: string }).message === "string") {
        message = (e as { message: string }).message;
      }
      if (message.includes("duplicate key value") && message.includes("slug_key")) {
        message = "A column with this slug already exists. Please choose a different slug.";
      }
      toaster.error({
        title: "Error",
        description: message
      });
    }
  };

  return (
    <Dialog.Root open={isOpen} size={"md"} placement={"center"} lazyMount unmountOnExit>
      <Dialog.Trigger asChild>
        <Button variant="surface" size="sm" colorPalette="green" onClick={() => setIsOpen(true)}>
          <Icon as={FiPlus} mr={2} /> Add Column
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Add Column</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body as="form" onSubmit={handleSubmit(onSubmit)}>
              <VStack gap={3} align="stretch">
                <Box>
                  <Label htmlFor="name">
                    Name
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input id="name" {...register("name", { required: "Name is required" })} placeholder="Column Name" />
                  {errors.name && (
                    <Text color="red.500" fontSize="sm">
                      {errors.name.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" {...register("description")} placeholder="Description" />
                  {errors.description && (
                    <Text color="red.500" fontSize="sm">
                      {errors.description.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="maxScore">
                    Max Score
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input
                    id="maxScore"
                    type="number"
                    {...register("maxScore", {
                      required: "Max Score is required",
                      valueAsNumber: true,
                      min: { value: 1, message: "Max Score must be at least 1" }
                    })}
                    step="any"
                    placeholder="Max Score"
                  />
                  {errors.maxScore && (
                    <Text color="red.500" fontSize="sm">
                      {errors.maxScore.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="slug">
                    Slug
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input id="slug" {...register("slug", { required: "Slug is required" })} placeholder="Slug" />
                  {errors.slug && (
                    <Text color="red.500" fontSize="sm">
                      {errors.slug.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="scoreExpression">Score Expression</Label>
                  <Textarea
                    id="scoreExpression"
                    {...register("scoreExpression")}
                    placeholder="Score Expression"
                    rows={4}
                  />
                  {errors.scoreExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.scoreExpression.message as string}
                    </Text>
                  )}
                  <ScoreExprDocs />
                </Box>
                <Box>
                  <Label htmlFor="renderExpression">Render Expression</Label>
                  <Input id="renderExpression" {...register("renderExpression")} placeholder="Render Expression" />
                  {errors.renderExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.renderExpression.message as string}
                    </Text>
                  )}
                  <RenderExprDocs />
                </Box>
                {addColumnScoreExpr && (
                  <Box>
                    <Checkbox {...register("instructorOnly")}>
                      Staff-only column (hidden from students until you release the column; then they see a snapshot of
                      the staff view, not a live recalculation)
                    </Checkbox>
                  </Box>
                )}
                <HStack justifyContent="flex-end">
                  <Button type="submit" colorPalette="green" loading={isLoading}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function EditColumnDialog({ columnId, onClose }: { columnId: number; onClose: () => void }) {
  const gradebookController = useGradebookController();
  const { mutateAsync: updateColumn } = useUpdate<GradebookColumn>({
    resource: "gradebook_columns"
  });
  const [isLoading, setIsLoading] = useState(false);
  const column = useGradebookColumn(columnId);

  type FormValues = {
    name: string;
    description?: string;
    maxScore: number;
    slug: string;
    scoreExpression?: string;
    renderExpression?: string;
    showCalculatedRanges?: boolean;
    instructorOnly: boolean;
  };

  const {
    register,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors }
  } = useForm<FormValues>({
    defaultValues: {
      name: column?.name ?? "",
      description: column?.description ?? "",
      maxScore: column?.max_score ?? 0,
      slug: column?.slug ?? "",
      scoreExpression: column?.score_expression ?? "",
      renderExpression: column?.render_expression ?? "",
      showCalculatedRanges: column?.show_calculated_ranges ?? false,
      instructorOnly: column?.instructor_only ?? false
    }
  });

  useEffect(() => {
    if (column) {
      reset({
        name: column.name ?? "",
        description: column.description ?? "",
        maxScore: column.max_score ?? 0,
        slug: column.slug ?? "",
        scoreExpression: column.score_expression ?? "",
        renderExpression: column.render_expression ?? "",
        showCalculatedRanges: column.show_calculated_ranges ?? false,
        instructorOnly: column.instructor_only ?? false
      });
    }
  }, [columnId, column, reset]);

  if (!columnId) return null;
  if (!column) throw new Error(`Column ${columnId} not found`);

  const scoreExpression = watch("scoreExpression");
  const canEditScoreExpression = scoreExpression && scoreExpression.startsWith("assignments(") ? false : true;

  const onSubmit = async (data: FieldValues) => {
    toaster.create({
      title: "Saving...",
      description: "This may take a few seconds to recalculate...",
      type: "info"
    });
    setIsLoading(true);
    try {
      const dependencies = gradebookController.extractAndValidateDependencies(data.scoreExpression ?? "", columnId);

      // Track which settings changed
      const settingsChanged: string[] = [];
      if (column.name !== data.name) settingsChanged.push("name");
      if (column.description !== data.description) settingsChanged.push("description");
      if (column.max_score !== data.maxScore) settingsChanged.push("max_score");
      if (column.slug !== data.slug) settingsChanged.push("slug");
      if ((column.score_expression ?? "") !== (data.scoreExpression ?? "")) settingsChanged.push("score_expression");
      if ((column.render_expression ?? "") !== (data.renderExpression ?? "")) settingsChanged.push("render_expression");
      if ((column.show_calculated_ranges ?? false) !== (data.showCalculatedRanges ?? false))
        settingsChanged.push("show_calculated_ranges");
      if ((column.instructor_only ?? false) !== (data.instructorOnly ?? false)) settingsChanged.push("instructor_only");

      await updateColumn({
        resource: "gradebook_columns",
        id: columnId,
        values: {
          name: data.name,
          description: data.description,
          max_score: data.maxScore,
          slug: data.slug,
          score_expression: data.scoreExpression?.length ? data.scoreExpression : null,
          render_expression: data.renderExpression?.length ? data.renderExpression : null,
          show_calculated_ranges: data.showCalculatedRanges ?? false,
          instructor_only: data.instructorOnly ?? false,
          dependencies
        }
      });

      setIsLoading(false);
      toaster.dismiss();
      onClose();
    } catch (e) {
      setIsLoading(false);
      toaster.dismiss();
      let message = "An unknown error occurred";
      if (e && typeof e === "object" && "message" in e && typeof (e as { message?: string }).message === "string") {
        message = (e as { message: string }).message;
      }
      setError("root", { message });
    }
  };

  return (
    <Dialog.Root open={true} size={"md"} placement={"center"} lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Edit Column</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body as="form" onSubmit={handleSubmit(onSubmit)}>
              <VStack gap={3} align="stretch">
                <Box>
                  <Label htmlFor="name">
                    Name
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input id="name" {...register("name", { required: "Name is required" })} placeholder="Column Name" />
                  {errors.name && (
                    <Text color="red.500" fontSize="sm">
                      {errors.name.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" {...register("description")} placeholder="Description" />
                  {errors.description && (
                    <Text color="red.500" fontSize="sm">
                      {errors.description.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="maxScore">
                    Max Score
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input
                    id="maxScore"
                    type="number"
                    {...register("maxScore", {
                      required: "Max Score is required",
                      valueAsNumber: true,
                      min: { value: 1, message: "Max Score must be at least 1" }
                    })}
                    step="any"
                    placeholder="Max Score"
                  />
                  {errors.maxScore && (
                    <Text color="red.500" fontSize="sm">
                      {errors.maxScore.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="slug">
                    Slug
                    <Text as="span" color="red.500" ml={1}>
                      *
                    </Text>
                  </Label>
                  <Input
                    id="slug"
                    {...register("slug", { required: "Slug is required" })}
                    placeholder="Slug"
                    disabled
                  />
                  {errors.slug && (
                    <Text color="red.500" fontSize="sm">
                      {errors.slug.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="scoreExpression">Score Expression</Label>
                  <Textarea
                    id="scoreExpression"
                    disabled={!canEditScoreExpression}
                    {...register("scoreExpression")}
                    placeholder="Score Expression"
                    rows={4}
                  />
                  {errors.scoreExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.scoreExpression.message as string}
                    </Text>
                  )}
                  <ScoreExprDocs />
                </Box>
                {scoreExpression && (
                  <Box>
                    <Checkbox {...register("showCalculatedRanges")} checked={watch("showCalculatedRanges") ?? false}>
                      Show calculated grade range predictions to students
                    </Checkbox>
                    {errors.showCalculatedRanges && (
                      <Text color="red.500" fontSize="sm">
                        {errors.showCalculatedRanges.message as string}
                      </Text>
                    )}
                  </Box>
                )}
                {scoreExpression && (
                  <Box>
                    <Checkbox {...register("instructorOnly")} checked={watch("instructorOnly") ?? false}>
                      Staff-only column (hidden from students until you release the column; then they see a snapshot of
                      the staff view)
                    </Checkbox>
                  </Box>
                )}
                <Box>
                  <Label htmlFor="renderExpression">Render Expression</Label>
                  <Input id="renderExpression" {...register("renderExpression")} placeholder="Render Expression" />
                  {errors.renderExpression && (
                    <Text color="red.500" fontSize="sm">
                      {errors.renderExpression.message as string}
                    </Text>
                  )}
                  <RenderExprDocs />
                </Box>
                {errors.root && (
                  <Text color="red.500" fontSize="sm">
                    {errors.root.message as string}
                  </Text>
                )}
                <HStack justifyContent="flex-end">
                  <Button type="submit" colorPalette="green" loading={isLoading}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ConvertMissingToZeroDialog({ columnId, onClose }: { columnId: number; onClose: () => void }) {
  const supabase = createClient();
  const [isConverting, setIsConverting] = useState(false);
  const column = useGradebookColumn(columnId);

  return (
    <Dialog.Root open={true} size={"md"} placement={"center"} lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Convert Missing to 0</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack gap={2} alignItems="flex-start">
                <Text>
                  &quot;Missing&quot; is a special value in Pawtograder to indicate that a student&apos;s grade for a
                  column has not been entered. Missing values do not count as 0s by default, and instead if a calculated
                  column depends on one, it is marked as &quot;not final.&quot; You should only convert missing values
                  to 0 if you are sure that you have finalized the grades for all students, and truly want to count this
                  item as 0. Are you sure you want to convert all missing values in column &quot;{column?.name}&quot; to
                  0? This action cannot be undone.
                </Text>
                <Text color="fg.error" fontWeight="bold">
                  All missing grades will be set to 0 with a note indicating the conversion.
                </Text>
                <HStack gap={2}>
                  <Button
                    colorPalette="red"
                    loading={isConverting}
                    onClick={async () => {
                      setIsConverting(true);
                      try {
                        await supabase
                          .from("gradebook_column_students")
                          .update({
                            score: 0,
                            is_missing: false,
                            score_override_note: "Missing value converted to 0"
                          })
                          .eq("gradebook_column_id", columnId)
                          .eq("is_private", true)
                          .or("is_missing.eq.true,and(score.is.null,score_override.is.null)");

                        toaster.success({
                          title: "Success",
                          description: "Missing values have been converted to 0"
                        });

                        onClose();
                      } catch {
                        toaster.error({
                          title: "Error",
                          description: "Failed to convert missing values"
                        });
                      } finally {
                        setIsConverting(false);
                      }
                    }}
                  >
                    Convert Missing to 0
                  </Button>
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function DeleteColumnDialog({ columnId, onClose }: { columnId: number; onClose: () => void }) {
  const supabase = createClient();
  const [isDeleting, setIsDeleting] = useState(false);
  const columns = useGradebookColumns();
  const gradebookController = useGradebookController();
  const dependentColumns = useMemo(() => {
    return columns.filter(
      (c) =>
        c.dependencies &&
        typeof c.dependencies === "object" &&
        "gradebook_columns" in c.dependencies &&
        (c.dependencies.gradebook_columns as number[])?.includes(columnId)
    );
  }, [columns, columnId]);
  return (
    <Dialog.Root open={true} size={"md"} placement={"center"} lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Delete Column</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {dependentColumns.length > 0 ? (
                <>
                  <Text>
                    You can not currently delete this column because it is a dependency for the following columns:
                  </Text>
                  <List.Root as="ul">
                    {dependentColumns.map((c) => (
                      <List.Item key={c.id}>
                        <Text fontWeight="bold">{c.name}</Text> <Code>{c.score_expression}</Code>
                      </List.Item>
                    ))}
                  </List.Root>
                  Please edit the dependent columns to remove this column as a dependency before deleting this column.
                  <Button w="100%" variant="ghost" onClick={onClose}>
                    Close
                  </Button>
                </>
              ) : (
                <VStack gap={2} alignItems="flex-start">
                  <Text>
                    Are you sure you want to delete this column? This action cannot be undone. All grades for this
                    column will be permanently deleted.
                  </Text>
                  <Text color="fg.error" fontWeight="bold">
                    You should expect that there is no way to undo this.
                  </Text>
                  <HStack gap={2}>
                    <Button
                      colorPalette="red"
                      loading={isDeleting}
                      onClick={async () => {
                        setIsDeleting(true);
                        await supabase.from("gradebook_column_students").delete().eq("gradebook_column_id", columnId);
                        await gradebookController.gradebook_columns.hardDelete(columnId);
                        onClose();
                      }}
                    >
                      Delete Column
                    </Button>
                    <Button variant="ghost" onClick={onClose}>
                      Cancel
                    </Button>
                  </HStack>
                </VStack>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ExternalDataAdvice({ externalData }: { externalData: GradebookColumnExternalData }) {
  return (
    <VStack gap={0} align="flex-start">
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Imported from CSV
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        File: {externalData.fileName}
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Date: <TimeZoneAwareDate date={externalData.date} format="compact" />
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Creator:
      </Text>
      <PersonName uid={externalData.creator} showAvatar={false} />
    </VStack>
  );
}

// New component for filtering a gradebook column
function GradebookColumnFilter({
  columnName,
  column_id,
  values,
  columnModel,
  isOpen,
  onClose,
  triggerRef
}: {
  columnName: string;
  column_id: number;
  values: GradebookColumnStudent[];
  columnModel: Column<UserProfile, unknown>;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
}) {
  const column = useGradebookColumn(column_id);
  const gradebookController = useGradebookController();
  const renderer = useMemo(() => gradebookController.getRendererForColumn(column_id), [gradebookController, column_id]);

  const uniqueValues = useMemo(() => {
    return [...new Set(values.map((grade) => String(grade.score_override ?? grade.score ?? "")))];
  }, [values]);

  const formatFilterLabel = useCallback(
    (rawNumeric: string) => {
      const n = Number(rawNumeric);
      if (rawNumeric === "" || Number.isNaN(n)) {
        return rawNumeric;
      }
      return String(
        renderer({
          score: n,
          score_override: null,
          max_score: column.max_score,
          is_missing: false,
          is_excused: false,
          is_droppable: false,
          released: true
        })
      );
    },
    [renderer, column.max_score]
  );

  const selectOptions = useMemo(() => {
    const labelToRaws = new Map<string, string[]>();
    for (const raw of uniqueValues) {
      const label = formatFilterLabel(raw);
      const list = labelToRaws.get(label);
      if (list) {
        if (!list.includes(raw)) list.push(raw);
      } else {
        labelToRaws.set(label, [raw]);
      }
    }
    return [...labelToRaws.entries()]
      .map(([label, raws]) => {
        raws.sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        });
        return {
          label,
          value: raws.join(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
        };
      })
      .sort((a, b) => {
        const aFirst = a.value.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0] ?? "";
        const bFirst = b.value.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0] ?? "";
        const na = Number(aFirst);
        const nb = Number(bFirst);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
        return a.label.localeCompare(b.label);
      });
  }, [uniqueValues, formatFilterLabel]);

  const currentValue = columnModel.getFilterValue() as string | string[];
  const selectedOptions = Array.isArray(currentValue)
    ? currentValue.map((val) => {
        const firstRaw = val.includes(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
          ? val.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0]
          : val;
        return { label: formatFilterLabel(firstRaw ?? val), value: val };
      })
    : currentValue
      ? [
          {
            label: formatFilterLabel(
              currentValue.includes(GRADEBOOK_SCORE_FILTER_GROUP_SEP)
                ? currentValue.split(GRADEBOOK_SCORE_FILTER_GROUP_SEP)[0]!
                : currentValue
            ),
            value: currentValue
          }
        ]
      : [];

  return (
    <PopoverRoot open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <PopoverTrigger asChild>
        <Box ref={triggerRef} />
      </PopoverTrigger>
      <PopoverContent
        bg="bg.surface"
        border="1px solid"
        borderColor="border.muted"
        borderRadius="md"
        boxShadow="lg"
        minW="300px"
        maxW="400px"
        zIndex={1000}
      >
        <PopoverBody p={3}>
          {/* Header with close button */}
          <HStack justifyContent="space-between" mb={3}>
            <Text fontWeight="semibold" fontSize="sm">
              Filter {columnName}
            </Text>
            <IconButton size="xs" variant="ghost" onClick={onClose} aria-label="Close filter">
              <Icon as={LuX} boxSize={4} />
            </IconButton>
          </HStack>

          {/* Filter input */}
          <Select
            size="sm"
            placeholder={`Filter ${columnName}...`}
            value={selectedOptions}
            onChange={(options) => {
              const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
              columnModel.setFilterValue(values.length > 0 ? values : "");
            }}
            options={selectOptions}
            isClearable
            isSearchable
            isMulti
            chakraStyles={{
              control: (provided) => ({
                ...provided,
                bg: "bg.surface",
                borderColor: "border.muted",
                _focus: { borderColor: "border.primary" }
              }),
              menu: (provided) => ({
                ...provided,
                bg: "bg.surface",
                border: "1px solid",
                borderColor: "border.muted"
              }),
              option: (provided, state) => ({
                ...provided,
                bg: state.isSelected ? "bg.primary" : state.isFocused ? "bg.subtle" : "bg.surface",
                color: state.isSelected ? "fg.inverse" : "fg.default",
                _hover: { bg: state.isSelected ? "bg.primary" : "bg.subtle" }
              })
            }}
          />
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

// Section filter component with enhanced select functionality
function SectionFilter({
  columnName,
  columnModel,
  isOpen,
  onClose,
  triggerRef,
  sections,
  type
}: {
  columnName: string;
  columnModel: Column<UserProfile, unknown>;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
  sections: ClassSection[] | LabSection[];
  type: "class" | "lab";
}) {
  const selectOptions = useMemo(() => {
    return sections.map((section) => ({
      label: type === "class" ? section.name : `${section.name}`,
      value: String(section.id)
    }));
  }, [sections, type]);

  const currentValue = columnModel.getFilterValue() as string | string[];
  const selectedOptions = Array.isArray(currentValue)
    ? currentValue.map((val) => {
        const section = sections.find((s) => String(s.id) === val);
        return {
          label: section ? (type === "class" ? section.name : `${section.name}`) : val,
          value: val
        };
      })
    : currentValue
      ? [
          {
            label: sections.find((s) => String(s.id) === currentValue)?.name || currentValue,
            value: currentValue
          }
        ]
      : [];

  return (
    <PopoverRoot open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <PopoverTrigger asChild>
        <Box ref={triggerRef} />
      </PopoverTrigger>
      <PopoverContent
        bg="bg.surface"
        border="1px solid"
        borderColor="border.muted"
        borderRadius="md"
        boxShadow="lg"
        minW="300px"
        maxW="400px"
        zIndex={1000}
      >
        <PopoverBody p={3}>
          <HStack justifyContent="space-between" mb={3}>
            <Text fontWeight="semibold" fontSize="sm">
              Filter {columnName}
            </Text>
            <IconButton size="xs" variant="ghost" onClick={onClose} aria-label="Close filter">
              <Icon as={LuX} boxSize={4} />
            </IconButton>
          </HStack>

          <Select
            size="sm"
            placeholder={`Filter ${columnName}...`}
            value={selectedOptions}
            onChange={(options) => {
              const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
              columnModel.setFilterValue(values.length > 0 ? values : "");
            }}
            options={selectOptions}
            isClearable
            isSearchable
            isMulti
            chakraStyles={{
              control: (provided) => ({
                ...provided,
                bg: "bg.surface",
                borderColor: "border.muted",
                _focus: { borderColor: "border.primary" }
              }),
              menu: (provided) => ({
                ...provided,
                bg: "bg.surface",
                border: "1px solid",
                borderColor: "border.muted"
              }),
              option: (provided, state) => ({
                ...provided,
                bg: state.isSelected ? "bg.primary" : state.isFocused ? "bg.subtle" : "bg.surface",
                color: state.isSelected ? "fg.inverse" : "fg.default",
                _hover: { bg: state.isSelected ? "bg.primary" : "bg.subtle" }
              })
            }}
          />
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}

function GenericColumnFilter({
  columnName,
  columnModel,
  isOpen,
  onClose,
  triggerRef,
  rowModel
}: {
  columnName: string;
  rowModel: RowModel<UserProfile>;
  columnModel: Column<UserProfile, unknown>;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
}) {
  const uniqueValues = useMemo(() => {
    const accessor = columnModel.accessorFn;
    if (!accessor) {
      return [];
    }
    const ret = rowModel.rows.map((row, idx) => accessor(row.original, idx) as string);
    return [...new Set(ret)];
  }, [rowModel, columnModel]);
  const selectOptions = useMemo(() => uniqueValues.map((value) => ({ label: value, value })), [uniqueValues]);

  const currentValue = columnModel.getFilterValue() as string | string[];
  const selectedOptions = Array.isArray(currentValue)
    ? currentValue.map((val) => ({ label: val, value: val }))
    : currentValue
      ? [{ label: currentValue, value: currentValue }]
      : [];

  return (
    <PopoverRoot open={isOpen} onOpenChange={(details) => !details.open && onClose()}>
      <PopoverTrigger asChild>
        <Box ref={triggerRef} />
      </PopoverTrigger>
      <PopoverContent
        bg="bg.surface"
        border="1px solid"
        borderColor="border.muted"
        borderRadius="md"
        boxShadow="lg"
        minW="300px"
        maxW="400px"
        zIndex={1000}
      >
        <PopoverBody p={3}>
          <Select
            size="sm"
            placeholder={`Filter ${columnName}...`}
            value={selectedOptions}
            onChange={(options) => {
              const values = Array.isArray(options) ? options.map((opt) => opt.value) : [];
              columnModel.setFilterValue(values.length > 0 ? values : "");
            }}
            options={selectOptions}
            isClearable
            isSearchable
            isMulti
          />
        </PopoverBody>
      </PopoverContent>
    </PopoverRoot>
  );
}
function GenericGradebookColumnHeader({
  columnName,
  isSorted,
  toggleSorting,
  clearSorting,
  columnModel,
  header,
  coreRowModel,
  classSections,
  labSections,
  dragHandle
}: {
  columnName: string;
  isSorted: "asc" | "desc" | false;
  toggleSorting: (direction: boolean) => void;
  clearSorting: () => void;
  columnModel: Column<UserProfile, unknown>;
  header: Header<UserProfile, unknown>;
  coreRowModel: RowModel<UserProfile>;
  classSections?: ClassSection[];
  labSections?: LabSection[];
  dragHandle?: React.ReactNode;
}) {
  const [showFilter, setShowFilter] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Determine if this is a section column
  const isClassSection = columnName === "class_section";
  const isLabSection = columnName === "lab_section";
  const isSectionColumn = isClassSection || isLabSection;

  return (
    <VStack gap={0} alignItems="stretch" w="100%" minH="48px">
      {/* Main header content */}
      <Box
        ref={ref}
        position="relative"
        p={0}
        bg="bg.surface"
        borderBottom="1px solid"
        borderColor="border.muted"
        minH="32px"
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        alignItems="stretch"
      >
        <HStack
          w="100%"
          justify="space-between"
          align="flex-start"
          minH={`${GRADE_HEADER_TOOLBAR_ROW_PX}px`}
          flexShrink={0}
          px={0}
          gap={0}
        >
          <Box flexShrink={0}>{dragHandle}</Box>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton size="2xs" variant="surface" aria-label="Column options" flexShrink={0} borderRadius={0}>
                <Icon as={FiChevronDown} />
              </IconButton>
            </MenuTrigger>
            <MenuContent minW="120px">
              <MenuItem value="filter" onClick={() => setShowFilter(!showFilter)}>
                <Icon as={FiFilter} boxSize={3} mr={2} />
                {showFilter ? "Hide Filter" : "Show Filter"}
              </MenuItem>
              <MenuItem value="asc" onClick={() => toggleSorting(false)}>
                {columnModel.getIsSorted() === "asc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowUp} boxSize={3} mr={2} />
                Sort Ascending
              </MenuItem>
              <MenuItem value="desc" onClick={() => toggleSorting(true)}>
                {columnModel.getIsSorted() === "desc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowDown} boxSize={3} mr={2} />
                Sort Descending
              </MenuItem>
              {isSorted && (
                <MenuItem value="clear" onClick={() => clearSorting()}>
                  Clear Sort
                </MenuItem>
              )}
            </MenuContent>
          </MenuRoot>
        </HStack>
        <Box px={1.5} pr={3} pb={0} flex="1" display="flex" flexDirection="column" justifyContent="space-between">
          <Text
            fontWeight="semibold"
            fontSize="sm"
            color="fg.default"
            lineHeight="tight"
            w="100%"
            minW={0}
            style={{
              userSelect: "none",
              display: "-webkit-box",
              WebkitLineClamp: GRADE_HEADER_MAX_TITLE_LINES,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              wordBreak: "break-word"
            }}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
          </Text>
          {showFilter && isSectionColumn && (
            <SectionFilter
              columnName={columnName}
              columnModel={columnModel}
              isOpen={showFilter}
              onClose={() => setShowFilter(false)}
              triggerRef={ref}
              sections={isClassSection ? classSections || [] : labSections || []}
              type={isClassSection ? "class" : "lab"}
            />
          )}
          {showFilter && !isSectionColumn && (
            <GenericColumnFilter
              columnName={columnName}
              columnModel={columnModel}
              isOpen={showFilter}
              onClose={() => setShowFilter(false)}
              triggerRef={ref}
              rowModel={coreRowModel}
            />
          )}
        </Box>
      </Box>
      <HStack alignItems="flex-end" w="100%" px={1.5}>
        <Box flex="1" display="flex" justifyContent="flex-end">
          {columnModel?.getIsFiltered() && (
            <WrappedTooltip content="Clear filter">
              <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={() => setShowFilter(true)}>
                <Icon as={TbFilter} />
              </IconButton>
            </WrappedTooltip>
          )}
        </Box>
      </HStack>
    </VStack>
  );
}

function GradebookColumnHeader({
  column_id,
  isSorted,
  toggleSorting,
  clearSorting,
  columnModel,
  dragHandle
}: {
  column_id: number;
  isSorted: "asc" | "desc" | false;
  toggleSorting: (direction: boolean) => void;
  clearSorting: () => void;
  columnModel: Column<UserProfile, unknown>;
  dragHandle?: React.ReactNode;
}) {
  const column = useGradebookColumn(column_id);
  const gradebookController = useGradebookController();
  const areAllDependenciesReleased = useAreAllDependenciesReleased(column_id);
  const allGrades = useGradebookColumnGrades(column_id);

  // Check for mixed release status (some students have released grades, others don't)
  const hasMixedReleaseStatus = useMemo(() => {
    if (allGrades.length === 0) return false;

    const releasedCount = allGrades.filter((grade) => grade.released).length;
    const totalCount = allGrades.length;

    // Mixed status: some but not all grades are released
    return releasedCount > 0 && releasedCount < totalCount;
  }, [allGrades]);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConvertingMissing, setIsConvertingMissing] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [isMovingLeft, setIsMovingLeft] = useState(false);
  const [isMovingRight, setIsMovingRight] = useState(false);
  const [isReleasing, setIsReleasing] = useState(false);
  const [isUnreleasing, setIsUnreleasing] = useState(false);
  const supabase = useMemo(() => createClient(), []);
  const headerRef = useRef<HTMLDivElement>(null);
  const isMovingRef = useRef(false);

  const moveLeft = useCallback(async () => {
    if (column.sort_order == null || isMovingRef.current) return;

    isMovingRef.current = true;
    setIsMovingLeft(true);
    try {
      const { error } = await supabase.rpc("gradebook_column_move_left", {
        p_column_id: column_id
      });

      if (error) throw error;
      await gradebookController.gradebook_columns.refetchByIds([column_id]);

      toaster.create({
        title: "Column moved left",
        description: `Successfully moved "${column.name}" to the left`,
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Failed to move column",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      isMovingRef.current = false;
      setIsMovingLeft(false);
    }
  }, [column_id, column, supabase, gradebookController]);

  const moveRight = useCallback(async () => {
    if (column.sort_order == null || isMovingRef.current) return;

    isMovingRef.current = true;
    setIsMovingRight(true);
    try {
      const { error } = await supabase.rpc("gradebook_column_move_right", {
        p_column_id: column_id
      });

      if (error) throw error;

      await gradebookController.gradebook_columns.refetchByIds([column_id]);

      toaster.create({
        title: "Column moved right",
        description: `Successfully moved "${column.name}" to the right`,
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Failed to move column",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      isMovingRef.current = false;
      setIsMovingRight(false);
    }
  }, [column_id, column, supabase, gradebookController]);

  const releaseColumn = useCallback(async () => {
    setIsReleasing(true);
    try {
      const { error } = await supabase.from("gradebook_columns").update({ released: true }).eq("id", column_id);

      if (error) throw error;

      await gradebookController.gradebook_columns.refetchByIds([column_id]);

      toaster.create({
        title: "Column released",
        description: `Successfully released "${column.name}" column`,
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Failed to release column",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      setIsReleasing(false);
    }
  }, [column_id, column, supabase, gradebookController]);

  const unreleaseColumn = useCallback(async () => {
    setIsUnreleasing(true);
    try {
      const { error } = await supabase.from("gradebook_columns").update({ released: false }).eq("id", column_id);

      if (error) throw error;

      await gradebookController.gradebook_columns.refetchByIds([column_id]);

      toaster.create({
        title: "Column unreleased",
        description: `Successfully unreleased "${column.name}" column`,
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Failed to unrelease column",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      setIsUnreleasing(false);
    }
  }, [column_id, column, supabase, gradebookController]);

  const toolTipText = useMemo(() => {
    const ret: string[] = [];
    if (column.description) {
      ret.push(`Description: ${column.description}`);
    }
    if (column.score_expression) {
      ret.push(`Auto-calculated using: ${column.score_expression}`);
      if (areAllDependenciesReleased) {
        ret.push("Students see the same calculation as you");
      } else {
        ret.push("Some dependencies are not released - students cannot see the same calculation that you see");
      }

      // Add mixed release status information
      if (hasMixedReleaseStatus) {
        const releasedCount = allGrades.filter((grade) => grade.released).length;
        const totalCount = allGrades.length;
        ret.push(`Mixed release status: ${releasedCount}/${totalCount} students can see their grades`);
      }
    }
    if (column.render_expression) {
      ret.push(`Rendered as ${column.render_expression}`);
    }
    if (!column.score_expression) {
      if (column.released) {
        ret.push("Released to students");
      } else {
        ret.push("Not released to students");
      }
    }
    return (
      <VStack gap={0} align="flex-start">
        {ret.map((t) => (
          <Text key={t}>{t}</Text>
        ))}
      </VStack>
    );
  }, [column, areAllDependenciesReleased, hasMixedReleaseStatus, allGrades]);

  return (
    <VStack gap={0} alignItems="stretch" w="100%" minH="48px" height="100%">
      {isEditing && (
        <EditColumnDialog
          columnId={column_id}
          onClose={() => {
            setIsEditing(false);
          }}
        />
      )}
      {isDeleting && (
        <DeleteColumnDialog
          columnId={column_id}
          onClose={() => {
            setIsDeleting(false);
          }}
        />
      )}
      {isConvertingMissing && (
        <ConvertMissingToZeroDialog
          columnId={column_id}
          onClose={() => {
            setIsConvertingMissing(false);
          }}
        />
      )}

      {/* Main header content */}
      <Box
        ref={headerRef}
        position="relative"
        h="100%"
        p={0}
        bg="bg.surface"
        borderBottom="1px solid"
        borderColor="border.muted"
        minH="32px"
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        alignItems="stretch"
      >
        <HStack
          w="100%"
          justify="space-between"
          align="flex-start"
          minH={`${GRADE_HEADER_TOOLBAR_ROW_PX}px`}
          flexShrink={0}
          px={0}
          gap={0}
        >
          <Box flexShrink={0}>{dragHandle}</Box>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton size="2xs" variant="surface" aria-label="Column options" flexShrink={0} borderRadius={0}>
                <Icon as={FiChevronDown} />
              </IconButton>
            </MenuTrigger>
            <MenuContent minW="160px">
              <MenuItem value="filter" onClick={() => setShowFilter(!showFilter)}>
                <Icon as={FiFilter} boxSize={3} mr={2} />
                {showFilter ? "Hide Filter" : "Show Filter"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem value="asc" onClick={() => toggleSorting(false)}>
                {isSorted === "asc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowUp} boxSize={3} mr={2} />
                Sort Ascending
              </MenuItem>
              <MenuItem value="desc" onClick={() => toggleSorting(true)}>
                {isSorted === "desc" && <Icon as={LuCheck} boxSize={3} mr={2} />}
                <Icon as={LuArrowDown} boxSize={3} mr={2} />
                Sort Descending
              </MenuItem>
              {isSorted && (
                <MenuItem value="clear" onClick={() => clearSorting()}>
                  Clear Sort
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem value="edit" onClick={() => setIsEditing(true)}>
                <Icon as={LuPencil} boxSize={3} mr={2} />
                Edit Column
              </MenuItem>
              <MenuItem
                value="moveLeft"
                onClick={moveLeft}
                disabled={isMovingLeft || isMovingRight}
                _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
              >
                {isMovingLeft ? <Spinner size="xs" mr={2} /> : <Icon as={LuArrowLeft} boxSize={3} mr={2} />}
                Move Left
              </MenuItem>
              <MenuItem
                value="moveRight"
                onClick={moveRight}
                disabled={isMovingLeft || isMovingRight}
                _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
              >
                {isMovingRight ? <Spinner size="xs" mr={2} /> : <Icon as={LuArrowRight} boxSize={3} mr={2} />}
                Move Right
              </MenuItem>
              {(!column.score_expression || column.instructor_only) && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    value="release"
                    onClick={releaseColumn}
                    disabled={isReleasing || isUnreleasing}
                    _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                  >
                    {isReleasing ? <Spinner size="xs" mr={2} /> : <Icon as={LuCheck} boxSize={3} mr={2} />}
                    Release Column
                  </MenuItem>
                  <MenuItem
                    value="unrelease"
                    onClick={unreleaseColumn}
                    disabled={isReleasing || isUnreleasing}
                    _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                  >
                    {isUnreleasing ? <Spinner size="xs" mr={2} /> : <Icon as={LuX} boxSize={3} mr={2} />}
                    Unrelease Column
                  </MenuItem>
                </>
              )}
              <MenuSeparator />
              {(!column.score_expression ||
                (column.score_expression && column.score_expression.startsWith("assignments("))) && (
                <MenuItem
                  value="convertMissing"
                  onClick={() => setIsConvertingMissing(true)}
                  color="fg.error"
                  _hover={{ bg: "bg.error", color: "fg.error" }}
                >
                  <Icon as={LuCalculator} boxSize={3} mr={2} />
                  Convert Missing to 0
                </MenuItem>
              )}
              <MenuItem
                value="delete"
                onClick={() => setIsDeleting(true)}
                color="fg.error"
                _hover={{ bg: "bg.error", color: "fg.error" }}
              >
                <Icon as={LuTrash} boxSize={3} mr={2} />
                Delete Column
              </MenuItem>
            </MenuContent>
          </MenuRoot>
        </HStack>

        <Box px={1.5} pr={3} pb={0} flex="1" display="flex" flexDirection="column" justifyContent="space-between">
          <WrappedTooltip content={toolTipText}>
            <Text
              fontWeight="semibold"
              fontSize="sm"
              color="fg.default"
              lineHeight="tight"
              w="100%"
              minW={0}
              style={{
                userSelect: "none",
                display: "-webkit-box",
                WebkitLineClamp: GRADE_HEADER_MAX_TITLE_LINES,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word"
              }}
            >
              {column.name}
            </Text>
          </WrappedTooltip>
          {showFilter && (
            <GradebookColumnFilter
              columnName={column.name}
              column_id={column_id}
              values={allGrades}
              columnModel={columnModel}
              isOpen={showFilter}
              onClose={() => setShowFilter(false)}
              triggerRef={headerRef}
            />
          )}
          <HStack gap={2} mt={0.5} justifyContent="space-between" w="100%" minW="fit-content">
            <HStack>
              {column.external_data && (
                <Box position="relative" zIndex={100}>
                  <Tooltip.Root lazyMount>
                    <Tooltip.Trigger asChild>
                      <Box position="relative" zIndex={100}>
                        <Icon as={LuFile} size="sm" color="fg.info" />
                      </Box>
                    </Tooltip.Trigger>
                    <Portal>
                      <Tooltip.Positioner style={{ zIndex: 10000 }}>
                        <Tooltip.Content>
                          <ExternalDataAdvice externalData={column.external_data as GradebookColumnExternalData} />
                        </Tooltip.Content>
                      </Tooltip.Positioner>
                    </Portal>
                  </Tooltip.Root>
                </Box>
              )}
              {column.score_expression ? (
                <Box position="relative" zIndex={10000}>
                  <WrappedTooltip
                    content={
                      column.instructor_only
                        ? "Staff-only: students do not see this column until it is released; then they see a frozen copy of the staff calculation"
                        : "Visibility: Students see this value calculated based on released dependencies"
                    }
                  >
                    <Icon as={LucideInfo} size="sm" color={column.instructor_only ? "purple.500" : "blue.500"} />
                  </WrappedTooltip>
                </Box>
              ) : hasMixedReleaseStatus ? (
                <Box position="relative" zIndex={100}>
                  <WrappedTooltip content="Some students have released grades, others don't">
                    <Icon as={LucideInfo} size="sm" color="red.500" />
                  </WrappedTooltip>
                </Box>
              ) : column.released ? (
                <Box position="relative" zIndex={100}>
                  <WrappedTooltip content="Released to students">
                    <Icon as={FaLockOpen} size="sm" color="green.500" />
                  </WrappedTooltip>
                </Box>
              ) : (
                <Box position="relative" zIndex={100}>
                  <WrappedTooltip content="Not released to students">
                    <Icon as={FaLock} size="sm" color="orange.500" />
                  </WrappedTooltip>
                </Box>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted" fontWeight="medium" minW="fit-content">
              Max: {column.max_score ?? "N/A"}
            </Text>
            {columnModel?.getIsFiltered() && (
              <WrappedTooltip content="Clear filter">
                <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={() => setShowFilter(true)}>
                  <Icon as={TbFilter} />
                </IconButton>
              </WrappedTooltip>
            )}
          </HStack>
        </Box>
      </Box>
    </VStack>
  );
}

function GradebookGapDropTarget({
  gapIndex,
  boundaryLeftPx,
  leafHeaderHeight,
  showHitLayer,
  lineVisible
}: {
  gapIndex: number;
  boundaryLeftPx: number;
  leafHeaderHeight: number;
  showHitLayer: boolean;
  lineVisible: boolean;
}) {
  const id = `${GRADEBOOK_GAP_PREFIX}${gapIndex}`;
  const { setNodeRef } = useDroppable({ id });
  const hitW = 28;
  return (
    <Box
      ref={setNodeRef}
      position="absolute"
      left={`${boundaryLeftPx - hitW / 2}px`}
      top={0}
      w={`${hitW}px`}
      h={`${leafHeaderHeight}px`}
      zIndex={showHitLayer ? 45 : 0}
      pointerEvents={showHitLayer ? "auto" : "none"}
    >
      {lineVisible && (
        <Box
          position="absolute"
          left="50%"
          top={0}
          h="100%"
          w="3px"
          ml="-1.5px"
          bg="blue.500"
          borderRadius="1px"
          pointerEvents="none"
          boxShadow="md"
        />
      )}
    </Box>
  );
}

const COL_MIN_WIDTH = 60;
const COL_MAX_WIDTH = 500;

function ColumnResizeHandle({
  columnId,
  liveWidthsRef,
  getColWidth,
  onResizeEnd
}: {
  columnId: string;
  liveWidthsRef: React.MutableRefObject<Map<string, number>>;
  getColWidth: (id: string) => number;
  onResizeEnd: (id: string, width: number) => void;
}) {
  const handleRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = liveWidthsRef.current.get(columnId) ?? getColWidth(columnId);
      const handleEl = handleRef.current;
      if (handleEl) handleEl.style.backgroundColor = "var(--chakra-colors-blue-400)";

      let rafId = 0;
      let latestWidth = startWidth;

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        const clamped = Math.max(COL_MIN_WIDTH, Math.min(COL_MAX_WIDTH, startWidth + delta));
        latestWidth = clamped;
        liveWidthsRef.current.set(columnId, clamped);

        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            const headerCell = document.querySelector(`[data-col-id="${columnId}"]`) as HTMLElement | null;
            if (headerCell) {
              headerCell.style.width = `${clamped}px`;
              headerCell.style.minWidth = `${clamped}px`;
            }
          });
        }
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        if (rafId) cancelAnimationFrame(rafId);
        if (handleEl) handleEl.style.backgroundColor = "";
        onResizeEnd(columnId, latestWidth);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [columnId, liveWidthsRef, getColWidth, onResizeEnd]
  );

  return (
    <Box
      ref={handleRef}
      position="absolute"
      right={0}
      top={0}
      bottom={0}
      w="6px"
      cursor="col-resize"
      zIndex={30}
      bg="transparent"
      _hover={{ bg: "blue.300" }}
      onPointerDown={onPointerDown}
      style={{ touchAction: "none" }}
    />
  );
}

function DraggableGradebookHeaderBox({
  header,
  vc,
  leafHeaderHeight,
  coreRowModel,
  classSections,
  labSections,
  showDragHandle,
  reorderDisabled,
  isDraggingThis,
  anyColumnDragging,
  liveWidthsRef,
  getColWidth,
  onResizeEnd
}: {
  header: Header<UserProfile, unknown>;
  vc: VirtualItem;
  leafHeaderHeight: number;
  coreRowModel: RowModel<UserProfile>;
  classSections?: ClassSection[];
  labSections?: LabSection[];
  showDragHandle: boolean;
  reorderDisabled?: boolean;
  isDraggingThis: boolean;
  anyColumnDragging: boolean;
  liveWidthsRef?: React.MutableRefObject<Map<string, number>>;
  getColWidth?: (id: string) => number;
  onResizeEnd?: (id: string, width: number) => void;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: header.column.id,
    disabled: !showDragHandle || reorderDisabled
  });

  const dragHandleEl = showDragHandle ? (
    <Box
      {...attributes}
      {...listeners}
      cursor={reorderDisabled ? "not-allowed" : "grab"}
      flexShrink={0}
      display="flex"
      alignItems="flex-start"
      aria-label="Drag to reorder column"
      opacity={reorderDisabled ? 0.35 : 1}
      _active={{ cursor: reorderDisabled ? "not-allowed" : "grabbing" }}
      pointerEvents={anyColumnDragging ? "none" : "auto"}
    >
      <Icon as={LuGripVertical} boxSize={3} color="fg.muted" />
    </Box>
  ) : undefined;

  const headerBody = header.column.id.startsWith("grade_") ? (
    <GradebookColumnHeader
      column_id={Number(header.column.id.slice(6))}
      isSorted={header.column.getIsSorted()}
      toggleSorting={header.column.toggleSorting}
      clearSorting={header.column.clearSorting}
      columnModel={header.column}
      dragHandle={dragHandleEl}
    />
  ) : header.isPlaceholder ? null : (
    <GenericGradebookColumnHeader
      columnName={header.column.id}
      isSorted={header.column.getIsSorted()}
      toggleSorting={header.column.toggleSorting}
      clearSorting={header.column.clearSorting}
      columnModel={header.column}
      header={header}
      coreRowModel={coreRowModel}
      classSections={classSections}
      labSections={labSections}
      dragHandle={dragHandleEl}
    />
  );

  return (
    <Box
      ref={setNodeRef}
      style={{
        position: "absolute",
        top: 0,
        left: `${vc.start}px`,
        width: `${vc.size}px`,
        zIndex: 10
      }}
      role="columnheader"
      bg="bg.muted"
      px={0}
      pt={0}
      pb={0}
      borderBottom="1px solid"
      borderLeft="1px solid"
      borderColor="border.emphasized"
      verticalAlign="top"
      minH={`${leafHeaderHeight}px`}
      opacity={isDraggingThis ? 0.35 : 1}
      pointerEvents={anyColumnDragging ? "none" : "auto"}
      data-col-id={header.column.id}
    >
      {headerBody}
      {liveWidthsRef && getColWidth && onResizeEnd && (
        <ColumnResizeHandle
          columnId={header.column.id}
          liveWidthsRef={liveWidthsRef}
          getColWidth={getColWidth}
          onResizeEnd={onResizeEnd}
        />
      )}
    </Box>
  );
}

function StudentNameCell({ uid }: { uid: string }) {
  const isObfuscated = useObfuscatedGradesMode();
  const canShowGradeFor = useCanShowGradeFor(uid);
  const setOnlyShowGradesFor = useSetOnlyShowGradesFor();
  const { setView } = useStudentDetailView();
  const toggleOnlyShowGradesFor = useCallback(() => {
    setOnlyShowGradesFor(canShowGradeFor ? "" : uid);
  }, [setOnlyShowGradesFor, uid, canShowGradeFor]);

  return (
    <HStack w="100%" pl={3}>
      <Link onClick={() => setView(uid)}>
        {" "}
        <PersonName uid={uid} size="2xs" showAvatar={false} />
      </Link>
      <Box flex="1" display="flex" justifyContent="flex-end">
        {isObfuscated && (
          <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={toggleOnlyShowGradesFor}>
            <Icon as={canShowGradeFor ? TbEyeOff : TbEye} />
          </IconButton>
        )}
      </Box>
    </HStack>
  );
}
const MemoizedStudentNameCell = React.memo(StudentNameCell);
function StudentDetailDialog() {
  const { view, setView } = useStudentDetailView();
  return (
    <Dialog.Root open={!!view} onOpenChange={(details) => (!details.open ? setView(null) : undefined)} lazyMount>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{view && <PersonName uid={view} size="md" />}</Dialog.Title>
          </Dialog.Header>
          <Dialog.Body>
            <Text fontSize="sm" color="fg.muted">
              This view allows you to simulate the impact of a grade change. Students have the exact same interface (but
              can only see released gradebook columns and scores).
            </Text>
            {view && (
              <GradebookWhatIfProvider private_profile_id={view}>
                <WhatIf private_profile_id={view} />
              </GradebookWhatIfProvider>
            )}
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
export default function GradebookTable() {
  const { course_id } = useParams();
  const students = useAllStudentRoles();
  const courseController = useCourseController();
  const gradebookController = useGradebookController();
  const gradebookColumns = useGradebookColumns();
  const [gradebookDataEpoch, setGradebookDataEpoch] = useState(0);
  useEffect(() => {
    return gradebookController.table.subscribeToData(() => {
      setGradebookDataEpoch((n) => n + 1);
    });
  }, [gradebookController]);

  const scoreMaps = useMemo(() => {
    const sortVal = new Map<string, Map<number, number | null>>();
    const filterVal = new Map<string, Map<number, number | null>>();
    const preferPrivate = true;
    for (const student of gradebookController.table.data) {
      const sid = student.private_profile_id;
      const sSort = new Map<number, number | null>();
      const sFilt = new Map<number, number | null>();
      for (const col of gradebookColumns) {
        let entry = student.entries.find((e) => e.gc_id === col.id && e.is_private === preferPrivate);
        if (!entry) entry = student.entries.find((e) => e.gc_id === col.id && e.is_private === !preferPrivate);
        const num = parseGradebookEntryScore(entry?.score_override, entry?.score);
        sSort.set(col.id, num);
        sFilt.set(col.id, num);
      }
      sortVal.set(sid, sSort);
      filterVal.set(sid, sFilt);
    }
    return { sortVal, filterVal };
  }, [gradebookColumns, gradebookDataEpoch, gradebookController]);

  const isInstructor = useIsInstructor();
  const isRefetching = useGradebookRefetchStatus();
  const isGradebookDataReady = useIsGradebookDataReady();

  // State for collapsible groups - use base group name as key for stability
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [isAutoLayouting, setIsAutoLayouting] = useState(false);
  const [exportWithRenderExpressions, setExportWithRenderExpressions] = useState(false);
  const [activeDragColumnId, setActiveDragColumnId] = useState<string | null>(null);
  const [activeDropGapIndex, setActiveDropGapIndex] = useState<number | null>(null);
  const [isReorderingColumns, setIsReorderingColumns] = useState(false);

  // Fetch class sections
  const { data: classSections } = useList<ClassSection>({
    resource: "class_sections",
    filters: [{ field: "class_id", operator: "eq", value: course_id as string }],
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    pagination: {
      pageSize: 1000
    }
  });

  // Get lab sections from course controller
  const { data: labSections } = courseController.listLabSections();

  // Map profile id to section ids and names
  const profileIdToSectionData = useMemo(() => {
    const map: Record<
      string,
      {
        classSection: { id: number | null; name: string };
        labSection: { id: number | null; name: string };
      }
    > = {};

    students.forEach((role) => {
      if (role.role === "student") {
        const classSection = classSections?.data?.find((s) => s.id === role.class_section_id);
        const labSection = labSections?.find((s) => s.id === role.lab_section_id);

        map[role.private_profile_id] = {
          classSection: {
            id: role.class_section_id ?? null,
            name: classSection?.name ?? "No Section"
          },
          labSection: {
            id: role.lab_section_id ?? null,
            name: labSection?.name ?? "No Lab Section"
          }
        };
      }
    });
    return map;
  }, [students, classSections?.data, labSections]);

  const columnsForGrouping = gradebookColumns.map((col) => ({
    id: col.id,
    slug: col.slug,
    sort_order: col.sort_order,
    name: col.name,
    max_score: col.max_score
  }));
  columnsForGrouping.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const cachedColumnsKey = JSON.stringify(columnsForGrouping);
  // Group gradebook columns by slug prefix, with special handling for assignment sub-groups
  const groupedColumns = useMemo(() => {
    const groups: Record<string, { groupName: string; columns: typeof columnsForGrouping }> = {};
    const columns = JSON.parse(cachedColumnsKey) as typeof columnsForGrouping;

    columns.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    let currentGroupKey = "";
    let currentGroupIndex = 0;
    let lastSortOrder = -1;

    columns.forEach((col) => {
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
  }, [cachedColumnsKey]);

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

  // Force recalculation helper
  const forceRecalculation = useCallback(() => {
    setTimeout(() => {
      // Recalculate header height
      if (headerRef.current) {
        const height = headerRef.current.offsetHeight;
        setHeaderHeight(height);
      }

      // Recalculate first column width
      if (students && students.length > 0) {
        const tempElement = document.createElement("div");
        tempElement.style.position = "absolute";
        tempElement.style.visibility = "hidden";
        tempElement.style.whiteSpace = "nowrap";
        tempElement.style.fontSize = "14px";
        tempElement.style.fontFamily = "inherit";
        document.body.appendChild(tempElement);

        let maxWidth = 180;
        students.forEach((student) => {
          tempElement.textContent = student.profiles.name || student.profiles.short_name || "Unknown Student";
          const textWidth = tempElement.offsetWidth;
          maxWidth = Math.max(maxWidth, textWidth + 60);
        });

        document.body.removeChild(tempElement);
        const finalWidth = Math.min(maxWidth, 400);
        setFirstColumnWidth(finalWidth);
      }
    }, 50);
  }, [students]);

  // Toggle group collapse/expand using base group name
  const toggleGroup = useCallback(
    (baseGroupName: string) => {
      setCollapsedGroups((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(baseGroupName)) {
          newSet.delete(baseGroupName);
        } else {
          newSet.add(baseGroupName);
        }
        return newSet;
      });

      // Force recalculation after toggle to fix alignment
      forceRecalculation();
    },
    [forceRecalculation]
  );

  const autoLayout = useCallback(async () => {
    const supabase = createClient();

    setIsAutoLayouting(true);
    try {
      const { error } = await supabase.rpc("gradebook_auto_layout", {
        p_gradebook_id: gradebookController.gradebook_id
      });

      if (error) throw error;

      toaster.create({
        title: "Auto-layout complete",
        description: "Successfully reorganized gradebook columns",
        type: "success"
      });
    } catch (error) {
      toaster.create({
        title: "Auto-layout failed",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        type: "error"
      });
    } finally {
      setIsAutoLayouting(false);
    }
  }, [gradebookController]);

  const downloadGradebookCsv = useCallback(() => {
    const csv = gradebookController.exportGradebook(courseController, {
      useRenderExpressions: exportWithRenderExpressions
    });
    const csvText = csv
      .map((row) =>
        row
          .map((cell) => {
            let stringCell = cell === null || cell === undefined ? "" : String(cell);
            if (/^[=+@-]/.test(stringCell)) {
              stringCell = `'${stringCell}`;
            }
            return `"${stringCell.replace(/"/g, '""')}"`;
          })
          .join(",")
      )
      .join("\n");
    // UTF-8 BOM so Excel (especially on Windows) opens the file as UTF-8; otherwise emoji show as mojibake.
    const csvTextWithBom = `\uFEFF${csvText}`;
    const blob = new Blob([csvTextWithBom], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gradebook.csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }, [courseController, exportWithRenderExpressions, gradebookController]);

  // Expand all groups
  const expandAll = useCallback(() => {
    setCollapsedGroups(new Set());
    forceRecalculation();
  }, [forceRecalculation]);

  // Collapse all groups
  const collapseAll = useCallback(() => {
    const allGroupKeys = Object.keys(groupedColumns).filter((key) => groupedColumns[key].columns.length > 1);
    const baseGroupNames = [...new Set(allGroupKeys.map((key) => groupedColumns[key].groupName))];
    setCollapsedGroups(new Set(baseGroupNames));
    forceRecalculation();
  }, [groupedColumns, forceRecalculation]);

  // Helper function to find the best column to show when collapsed
  const findBestColumnToShow = useCallback(
    (columns: typeof columnsForGrouping) => {
      // Start from the last column and work backwards
      for (let i = columns.length - 1; i >= 0; i--) {
        const col = columns[i];
        let hasNonMissingValues = false;

        // Check if this column has any non-missing values
        for (const student of students) {
          const controller = gradebookController.getStudentGradebookController(student.private_profile_id);
          const { item } = controller.getColumnForStudent(col.id);
          const score = item?.score_override ?? item?.score;

          if (score !== null && score !== undefined) {
            hasNonMissingValues = true;
            break;
          }
        }

        if (hasNonMissingValues) {
          return col;
        }
      }

      // If no column has non-missing values, return the last column
      return columns[columns.length - 1];
    },
    [students, gradebookController]
  );

  /**
   * Build columns with header groups
   *
   * Header groups are created from gradebook columns that share the same slug prefix
   * (everything before the first hyphen). Groups are only created when multiple
   * contiguous columns share the same prefix.
   *
   * Header Group Behavior:
   * - When EXPANDED: The group header spans all child columns using colSpan,
   *   and all individual column headers are shown below it
   * - When COLLAPSED: Only one representative column is shown (the one with
   *   the most recent non-missing data), and the group header covers just that column
   *
   * The width calculation ensures proper rendering:
   * - Collapsed: 120px (single column width)
   * - Expanded: 120px * number_of_columns_in_group
   */
  const columns: ColumnDef<UserProfile, unknown>[] = useMemo(() => {
    const cols: ColumnDef<UserProfile, unknown>[] = [
      {
        id: "student_name",
        header: "Student Name",
        accessorFn: (row) => row.name,
        cell: ({ row }) => <MemoizedStudentNameCell uid={row.original.id} />,
        enableColumnFilter: true,
        filterFn: (row, columnId, filterValue) => {
          const studentName = row.original.name || "";
          if (!filterValue) return true;
          if (Array.isArray(filterValue)) {
            // When multiple names are selected, check if student name is in the array
            return filterValue.some((name) => studentName.toLowerCase().includes(String(name).toLowerCase()));
          }
          // Single string filter - case-insensitive partial match
          return studentName.toLowerCase().includes(String(filterValue).toLowerCase());
        },
        enableSorting: true
      }
    ];

    // Only add class section column if there are class sections
    if (classSections?.data && classSections.data.length > 0) {
      cols.push({
        id: "class_section",
        header: "Class Section",
        accessorFn: (row) => profileIdToSectionData[row.id]?.classSection?.name ?? "No Section",
        cell: ({ row }) => {
          const name = profileIdToSectionData[row.original.id]?.classSection?.name ?? "No Section";
          return (
            <WrappedTooltip content={name}>
              <Text fontSize="sm" truncate>
                {name}
              </Text>
            </WrappedTooltip>
          );
        },
        enableColumnFilter: true,
        filterFn: (row, columnId, filterValue) => {
          const sectionData = profileIdToSectionData[row.original.id]?.classSection;
          if (!sectionData || !filterValue) return true;
          if (Array.isArray(filterValue)) {
            return filterValue.includes(String(sectionData.id));
          }
          return String(sectionData.id) === filterValue;
        },
        enableSorting: true
      });
    }

    // Only add lab section column if there are lab sections
    if (labSections && labSections.length > 0) {
      cols.push({
        id: "lab_section",
        header: "Lab Section",
        accessorFn: (row) => profileIdToSectionData[row.id]?.labSection?.name ?? "No Lab Section",
        cell: ({ row }) => {
          const name = profileIdToSectionData[row.original.id]?.labSection?.name ?? "No Lab Section";
          return (
            <WrappedTooltip content={name}>
              <Text fontSize="sm" truncate>
                {name}
              </Text>
            </WrappedTooltip>
          );
        },
        enableColumnFilter: true,
        filterFn: (row, columnId, filterValue) => {
          const sectionData = profileIdToSectionData[row.original.id]?.labSection;
          if (!sectionData || !filterValue) return true;
          if (Array.isArray(filterValue)) {
            return filterValue.includes(String(sectionData.id));
          }
          return String(sectionData.id) === filterValue;
        },
        enableSorting: true
      });
    }

    // Add grouped gradebook columns
    Object.entries(groupedColumns).forEach(([groupKey, group]) => {
      if (group.columns.length === 1) {
        // Single column - no need for group header
        const col = group.columns[0];
        cols.push({
          id: `grade_${col.id}`,
          header: col.name,
          accessorFn: (row) => scoreMaps.sortVal.get(row.id)?.get(col.id) ?? null,
          sortingFn: (rowA, rowB, columnId) =>
            compareGradeColumnSortValues(rowA.getValue(columnId), rowB.getValue(columnId)),
          cell: ({ row }) => {
            return <MemoizedGradebookCell columnId={col.id} studentId={row.original.id} />;
          },
          enableColumnFilter: true,
          filterFn: (row, columnId, filterValue) => {
            const fv = scoreMaps.filterVal.get(row.original.id)?.get(col.id) ?? null;
            return gradebookScoreFilterMatches(filterValue, gradebookScoreToFilterRawString(fv));
          },
          enableSorting: true
        });
      } else {
        // Multiple columns - handle collapsed state using base group name
        const isCollapsed = collapsedGroups.has(group.groupName);
        const columnsToShow = isCollapsed ? [findBestColumnToShow(group.columns)] : group.columns;

        columnsToShow.forEach((col) => {
          cols.push({
            id: `grade_${col.id}`,
            header: col.name,
            accessorFn: (row) => scoreMaps.sortVal.get(row.id)?.get(col.id) ?? null,
            sortingFn: (rowA, rowB, columnId) =>
              compareGradeColumnSortValues(rowA.getValue(columnId), rowB.getValue(columnId)),
            cell: ({ row }) => {
              return <MemoizedGradebookCell columnId={col.id} studentId={row.original.id} />;
            },
            enableColumnFilter: true,
            filterFn: (row, columnId, filterValue) => {
              const fv = scoreMaps.filterVal.get(row.original.id)?.get(col.id) ?? null;
              return gradebookScoreFilterMatches(filterValue, gradebookScoreToFilterRawString(fv));
            },
            enableSorting: true,
            meta: {
              groupName: group.groupName,
              groupKey: groupKey,
              isCollapsed: isCollapsed
            }
          });
        });
      }
    });

    return cols;
  }, [
    profileIdToSectionData,
    gradebookController,
    groupedColumns,
    collapsedGroups,
    findBestColumnToShow,
    classSections?.data,
    labSections,
    scoreMaps
  ]);

  const studentProfiles = useMemo(() => {
    return students.map((student) => student.profiles);
  }, [students]);
  // Table instance
  const table = useReactTable({
    data: studentProfiles,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      sorting: [{ id: "student_name", desc: false }]
    }
  });

  const headerGroups = table.getHeaderGroups();
  const rowModel = table.getRowModel();
  const coreRowModel = table.getCoreRowModel();

  const visibleLeafColumns = table.getVisibleLeafColumns();
  const firstGradeColIdx = visibleLeafColumns.findIndex((c) => c.id.startsWith("grade_"));
  const frozenColumnCount = firstGradeColIdx === -1 ? visibleLeafColumns.length : firstGradeColIdx;
  const scrollableLeafColumns = useMemo(() => {
    const leaf = table.getVisibleLeafColumns();
    const idx = leaf.findIndex((c) => c.id.startsWith("grade_"));
    return idx === -1 ? [] : leaf.slice(idx);
  }, [table, columns, collapsedGroups, cachedColumnsKey]);

  // Column resize state: committed widths (triggers re-render) + live ref (no re-render during drag)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const liveWidthsRef = useRef<Map<string, number>>(new Map());
  const getColWidth = useCallback((colId: string): number => columnWidths[colId] ?? GRADE_COL_WIDTH, [columnWidths]);

  const scrollableWidth = useMemo(
    () => scrollableLeafColumns.reduce((sum, col) => sum + getColWidth(col.id), 0),
    [scrollableLeafColumns, getColWidth]
  );

  const visibleReorderUnits = useMemo(
    () =>
      buildVisibleReorderUnits({
        scrollableLeafColumns,
        groupedColumns,
        collapsedGroups,
        findBestColumnToShow,
        gradebookColumns
      }),
    [scrollableLeafColumns, groupedColumns, collapsedGroups, findBestColumnToShow, gradebookColumns]
  );

  const fullGradeColumnIdsOrdered = useMemo(
    () => [...gradebookColumns].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((c) => c.id),
    [gradebookColumns]
  );

  const supabaseForGradebook = useMemo(() => createClient(), []);

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleGradebookColumnDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragColumnId(String(event.active.id));
    setActiveDropGapIndex(null);
  }, []);

  const handleGradebookColumnDragCancel = useCallback(() => {
    setActiveDragColumnId(null);
    setActiveDropGapIndex(null);
  }, []);

  const handleGradebookColumnDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over?.id;
    if (overId == null || typeof overId !== "string") {
      setActiveDropGapIndex(null);
      return;
    }
    if (!overId.startsWith(GRADEBOOK_GAP_PREFIX)) {
      setActiveDropGapIndex(null);
      return;
    }
    const n = Number(overId.slice(GRADEBOOK_GAP_PREFIX.length));
    if (!Number.isFinite(n)) {
      setActiveDropGapIndex(null);
      return;
    }
    setActiveDropGapIndex(n);
  }, []);

  const handleGradebookColumnDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragColumnId(null);
      setActiveDropGapIndex(null);
      if (!isInstructor) return;

      const overId = over?.id;
      if (overId == null || typeof overId !== "string" || !overId.startsWith(GRADEBOOK_GAP_PREFIX)) return;

      const gapIndex = Number(overId.slice(GRADEBOOK_GAP_PREFIX.length));
      if (!Number.isFinite(gapIndex) || gapIndex < 0 || gapIndex > visibleReorderUnits.length) return;

      const activeIdStr = String(active.id);
      if (!activeIdStr.startsWith("grade_")) return;
      const draggedColumnId = Number(activeIdStr.slice(6));

      const merged = insertColumnAtGap(fullGradeColumnIdsOrdered, draggedColumnId, visibleReorderUnits, gapIndex);
      const unchanged =
        merged.length === fullGradeColumnIdsOrdered.length &&
        merged.every((id, i) => id === fullGradeColumnIdsOrdered[i]);
      if (unchanged) return;

      setIsReorderingColumns(true);
      try {
        const { error } = await supabaseForGradebook.rpc("gradebook_columns_reorder", {
          p_ordered_column_ids: merged
        });
        if (error) throw error;
        await gradebookController.gradebook_columns.refetchAll();
        toaster.create({
          title: "Columns reordered",
          type: "success"
        });
      } catch (e) {
        toaster.create({
          title: "Failed to reorder columns",
          description: e instanceof Error ? e.message : "Unexpected error",
          type: "error"
        });
      } finally {
        setIsReorderingColumns(false);
      }
    },
    [isInstructor, visibleReorderUnits, fullGradeColumnIdsOrdered, supabaseForGradebook, gradebookController]
  );

  const dragOverlayColumn = useMemo(() => {
    if (!activeDragColumnId?.startsWith("grade_")) return null;
    const id = Number(activeDragColumnId.slice(6));
    return gradebookColumns.find((c) => c.id === id) ?? null;
  }, [activeDragColumnId, gradebookColumns]);

  // Virtualization setup
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLTableSectionElement>(null);

  // Dynamic first column width calculation
  const [firstColumnWidth, setFirstColumnWidth] = useState(180); // Default width

  // Header height state for Safari compatibility
  const [headerHeight, setHeaderHeight] = useState(0);

  /** Uniform height for leaf header row (pre-measured; matches clamped title + toolbar + status row). */
  const minGradeColWidth = useMemo(() => {
    if (scrollableLeafColumns.length === 0) return GRADE_COL_WIDTH;
    return Math.min(...scrollableLeafColumns.map((c) => getColWidth(c.id)));
  }, [scrollableLeafColumns, getColWidth]);

  const leafHeaderHeight = useMemo(() => {
    const names = gradebookColumns.map((c) => c.name).filter((n): n is string => Boolean(n && String(n).trim()));
    return measureMaxGradeHeaderHeight(names, minGradeColWidth, GRADE_HEADER_MAX_TITLE_LINES);
  }, [gradebookColumns, minGradeColWidth]);

  // Detect Safari browser
  const isSafari = useMemo(() => {
    if (typeof window === "undefined") return false;
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  }, []);

  const calculateFirstColumnWidth = useCallback(() => {
    if (!students || students.length === 0) return;

    // Create a temporary element to measure text width
    const tempElement = document.createElement("div");
    tempElement.style.position = "absolute";
    tempElement.style.visibility = "hidden";
    tempElement.style.whiteSpace = "nowrap";
    tempElement.style.fontSize = "14px"; // Match the font size used in PersonName
    tempElement.style.fontFamily = "inherit";
    document.body.appendChild(tempElement);

    let maxWidth = 180; // Minimum width

    // Measure each student name
    students.forEach((student) => {
      tempElement.textContent = student.profiles.name || student.profiles.short_name || "Unknown Student";
      const textWidth = tempElement.offsetWidth;
      maxWidth = Math.max(maxWidth, textWidth + 60); // Add padding for icons and spacing
    });

    // Clean up
    document.body.removeChild(tempElement);

    // Set a reasonable maximum width
    const finalWidth = Math.min(maxWidth, 400); // Cap at 400px
    setFirstColumnWidth(finalWidth);
  }, [students]);

  const calculateHeaderHeight = useCallback(() => {
    if (headerRef.current) {
      const height = headerRef.current.offsetHeight;
      setHeaderHeight(height);
    }
  }, []);

  // Calculate width when students change
  useEffect(() => {
    calculateFirstColumnWidth();
  }, [calculateFirstColumnWidth]);

  // Calculate header height after render and when columns/groups / computed leaf height change
  useEffect(() => {
    calculateHeaderHeight();
  }, [calculateHeaderHeight, gradebookColumns.length, groupedColumns, collapsedGroups, leafHeaderHeight]);

  // Force recalculation after a short delay to handle async rendering
  useEffect(() => {
    const timer = setTimeout(() => {
      forceRecalculation();
    }, 100);
    return () => clearTimeout(timer);
  }, [forceRecalculation, groupedColumns, collapsedGroups]);

  // Add ResizeObserver to handle layout changes
  useEffect(() => {
    if (!parentRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      forceRecalculation();
    });

    resizeObserver.observe(parentRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [forceRecalculation]);

  const colEstimateSize = useCallback(
    (index: number) => getColWidth(scrollableLeafColumns[index]?.id ?? ""),
    [getColWidth, scrollableLeafColumns]
  );

  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: scrollableLeafColumns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: colEstimateSize,
    overscan: 3
  });

  const handleColumnResizeEnd = useCallback(
    (colId: string, newWidth: number) => {
      if (colId === "student_name") {
        setFirstColumnWidth(newWidth);
      } else {
        setColumnWidths((prev) => ({ ...prev, [colId]: newWidth }));
      }
      liveWidthsRef.current.delete(colId);
      setTimeout(() => {
        columnVirtualizer.measure();
        if (headerRef.current) {
          setHeaderHeight(headerRef.current.offsetHeight);
        }
      }, 0);
    },
    [columnVirtualizer]
  );

  const virtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 45, // Estimated row height in pixels
    overscan: 20
  });

  const virtualRows = virtualizer.getVirtualItems();

  const scrollableRow1Segments = useMemo(() => {
    type Seg = {
      left: number;
      width: number;
      key: string;
      groupName: string;
      isCollapsed: boolean;
      groupColumnsLen: number;
    };
    const segments: Seg[] = [];
    let pos = 0;
    let i = 0;
    while (i < scrollableLeafColumns.length) {
      const leaf = scrollableLeafColumns[i];
      const columnId = Number(leaf.id.slice(6));
      const column = gradebookColumns.find((c) => c.id === columnId);
      if (!column) {
        pos += getColWidth(leaf.id);
        i++;
        continue;
      }
      const prefix = column.slug.split("-")[0];
      const baseGroupName = prefix || "other";
      const groupEntry = Object.entries(groupedColumns).find(
        ([key, group]) => key.startsWith(baseGroupName) && group.columns.some((col) => col.id === columnId)
      );
      if (!groupEntry || groupEntry[1].columns.length <= 1) {
        pos += getColWidth(leaf.id);
        i++;
        continue;
      }
      const group = groupEntry[1];
      const groupColumns = group.columns;
      const isFirstInGroup = groupColumns[0].id === columnId;
      const isCollapsed = collapsedGroups.has(group.groupName);
      const bestCol = findBestColumnToShow(groupColumns);
      const isVisibleWhenCollapsed = isCollapsed && columnId === bestCol.id;

      if (isFirstInGroup || isVisibleWhenCollapsed) {
        const span = isCollapsed ? 1 : groupColumns.length;
        let width = 0;
        for (let j = 0; j < span && i + j < scrollableLeafColumns.length; j++) {
          width += getColWidth(scrollableLeafColumns[i + j].id);
        }
        segments.push({
          left: pos,
          width,
          key: `grp-${group.groupName}-${columnId}`,
          groupName: group.groupName,
          isCollapsed,
          groupColumnsLen: groupColumns.length
        });
        pos += width;
        i += span;
      } else if (!isCollapsed) {
        i++;
      } else {
        i++;
      }
    }
    return segments;
  }, [scrollableLeafColumns, gradebookColumns, groupedColumns, collapsedGroups, findBestColumnToShow, getColWidth]);

  const filterHeader = useCallback(
    (header: Header<UserProfile, unknown>) => {
      if (header.column.id.startsWith("grade_")) {
        const columnId = Number(header.column.id.slice(6));
        const column = gradebookColumns.find((col) => col.id === columnId);

        if (column) {
          const prefix = column.slug.split("-")[0];
          const baseGroupName = prefix || "other";

          const groupEntry = Object.entries(groupedColumns).find(
            ([key, group]) => key.startsWith(baseGroupName) && group.columns.some((col) => col.id === columnId)
          );

          if (groupEntry && groupEntry[1].columns.length > 1) {
            const isCollapsed = collapsedGroups.has(groupEntry[1].groupName);

            if (isCollapsed) {
              const bestColumn = findBestColumnToShow(groupEntry[1].columns);
              return columnId === bestColumn.id;
            }
          }
        }
      }
      return true;
    },
    [gradebookColumns, groupedColumns, collapsedGroups, findBestColumnToShow]
  );

  const renderVirtualRow = useCallback(
    (virtualRow: VirtualItem) => {
      const row = rowModel.rows[virtualRow.index];
      if (!row) return null;

      const idx = virtualRow.index;
      const cells = row.getVisibleCells();
      const frozenCells = cells.slice(0, frozenColumnCount);
      const scrollCells = cells.slice(frozenColumnCount);

      const cellBody = (cell: (typeof cells)[0], isStickyFirst: boolean, asTableCell: boolean) => {
        const isCollapsedColumn = (cell.column.columnDef.meta as { isCollapsed?: boolean })?.isCollapsed;
        const inner = (
          <>
            {isCollapsedColumn && (
              <IconButton
                size="xs"
                variant="ghost"
                position="absolute"
                left={0}
                top={0}
                bottom={0}
                onClick={() => toggleGroup((cell.column.columnDef.meta as { groupName?: string })?.groupName || "")}
                aria-label="Expand group"
                colorPalette="blue"
                opacity={0.8}
                _hover={{ opacity: 1, bg: "bg.info" }}
                zIndex={10}
                minW="auto"
                h="auto"
                p={0}
                w={8}
                bg="bg.surface"
                border="1px solid"
                borderColor="border.muted"
                borderRadius={0}
              >
                <Icon as={LuChevronRight} boxSize={5} />
              </IconButton>
            )}
            <Box pl={isCollapsedColumn ? 8 : 0} overflow="hidden" w="100%" minW={0}>
              {cell.column.columnDef.cell
                ? flexRender(cell.column.columnDef.cell, cell.getContext())
                : String(cell.getValue())}
            </Box>
          </>
        );

        const bg = isStickyFirst
          ? idx % 2 === 0
            ? "bg.subtle"
            : "bg.muted"
          : isCollapsedColumn
            ? "bg.warning"
            : idx % 2 === 0
              ? "bg.subtle"
              : "bg.muted";

        const styleBase = {
          ...(isStickyFirst
            ? {
                position: "sticky" as const,
                left: 0,
                zIndex: 18,
                borderRight: "1px solid var(--chakra-colors-border-muted)",
                width: `${firstColumnWidth}px`,
                maxWidth: `${firstColumnWidth}px`,
                minWidth: `${firstColumnWidth}px`
              }
            : {
                width: `${getColWidth(cell.column.id)}px`,
                maxWidth: `${getColWidth(cell.column.id)}px`,
                minWidth: `${getColWidth(cell.column.id)}px`,
                zIndex: 1
              }),
          ...(isCollapsedColumn
            ? {
                borderLeft: "2px solid var(--chakra-colors-border-warning)"
              }
            : {}),
          height: `${virtualRow.size}px`,
          verticalAlign: "middle" as const,
          boxSizing: "border-box" as const,
          overflow: "hidden" as const
        };

        if (asTableCell) {
          return (
            <Table.Cell
              key={cell.id}
              p={2}
              position="relative"
              bg={bg}
              style={{ ...styleBase, display: "table-cell" }}
              className={isStickyFirst ? "sticky-first-cell" : undefined}
            >
              {inner}
            </Table.Cell>
          );
        }

        return (
          <Box
            key={cell.id}
            data-gradebook-scroll-cell=""
            p={2}
            position="relative"
            bg={bg}
            {...styleBase}
            display="flex"
            alignItems="center"
          >
            {inner}
          </Box>
        );
      };

      return (
        <Table.Row
          key={`${row.id}-${virtualRow.index}`}
          role="row"
          aria-label={`Student ${row.original.name || "Unknown"} grades`}
          bg={idx % 2 === 0 ? "bg.subtle" : "bg.muted"}
          _hover={{ bg: "bg.info" }}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: `${virtualRow.size}px`,
            transform: `translateY(${virtualRow.start + (isSafari ? headerHeight || 120 : 0)}px)`,
            display: "table",
            tableLayout: "fixed"
          }}
        >
          {frozenCells.map((cell, colIdx) => cellBody(cell, colIdx === 0, true))}
          <Table.Cell
            key={`${row.id}-scroll-region`}
            p={0}
            position="relative"
            style={{
              width: scrollableWidth,
              minWidth: scrollableWidth,
              maxWidth: scrollableWidth,
              height: `${virtualRow.size}px`,
              verticalAlign: "middle",
              display: "table-cell",
              boxSizing: "border-box"
            }}
          >
            <Box position="relative" w={`${scrollableWidth}px`} h={`${virtualRow.size}px`}>
              {columnVirtualizer.getVirtualItems().map((vc) => {
                const cell = scrollCells[vc.index];
                if (!cell) return null;
                return (
                  <Box key={cell.id} position="absolute" top={0} left={`${vc.start}px`} w={`${vc.size}px`} h="100%">
                    {cellBody(cell, false, false)}
                  </Box>
                );
              })}
            </Box>
          </Table.Cell>
        </Table.Row>
      );
    },
    [
      rowModel.rows,
      frozenColumnCount,
      scrollableWidth,
      columnVirtualizer,
      toggleGroup,
      firstColumnWidth,
      headerHeight,
      isSafari,
      getColWidth
    ]
  );

  if (!students || !isGradebookDataReady) {
    return (
      <VStack gap={2} align="center" justify="center" minH="40vh">
        <Spinner size="lg" color="blue.500" />
        <Text fontSize="sm" color="fg.emphasized" fontWeight="medium">
          {!students ? "Loading students..." : "Loading gradebook data..."}
        </Text>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" w="100%" gap={0} position="relative">
      {/* Gradebook data loading overlay */}
      {!isGradebookDataReady && (
        <Box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          bg="rgba(255, 255, 255, 0.8)"
          zIndex={1000}
          display="flex"
          alignItems="center"
          justifyContent="center"
          borderRadius="md"
        >
          <VStack gap={2}>
            <Spinner size="lg" color="blue.500" />
            <Text fontSize="sm" color="fg.emphasized" fontWeight="medium">
              {isRefetching ? "Refreshing gradebook data..." : "Loading gradebook index..."}
            </Text>
          </VStack>
        </Box>
      )}

      <style jsx global>{`
        [data-gradebook-container] tbody tr:hover td,
        [data-gradebook-container] tbody tr:hover [data-gradebook-scroll-cell] {
          background-color: var(--chakra-colors-bg-info) !important;
        }
        @keyframes gradebook-pulse {
          0%,
          100% {
            opacity: 0.4;
          }
          50% {
            opacity: 1;
          }
        }
        .gradebook-cell-pulse {
          animation: gradebook-pulse 2s ease-in-out infinite;
        }
      `}</style>
      <Toaster />
      <StudentDetailDialog />
      <GradebookPopoverProvider>
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragStart={handleGradebookColumnDragStart}
          onDragOver={handleGradebookColumnDragOver}
          onDragEnd={handleGradebookColumnDragEnd}
          onDragCancel={handleGradebookColumnDragCancel}
          modifiers={[restrictToHorizontalAxis]}
        >
          <GradebookPointerOpener
            ref={parentRef}
            data-gradebook-container=""
            overflowX="auto"
            overflowY="auto"
            maxW="100%"
            maxH="80vh"
            height="80vh"
            position="relative"
            role="region"
            aria-label="Instructor Gradebook Table"
            tabIndex={0}
          >
            <Table.Root
              minW={`${firstColumnWidth + visibleLeafColumns.slice(1, frozenColumnCount).reduce((s, c) => s + getColWidth(c.id), 0) + scrollableWidth}px`}
              w="100%"
              role="table"
              aria-label="Student grades by assignment"
              style={{
                tableLayout: "fixed",
                width: "100%",
                margin: 0,
                padding: 0,
                borderSpacing: 0,
                position: "relative"
              }}
            >
              <Table.Header
                ref={headerRef}
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 20,
                  backgroundColor: "var(--chakra-colors-bg-subtle)",
                  borderBottom: "2px solid var(--chakra-colors-border-muted)",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.1)"
                }}
              >
                {/* 
              Group Header Row - This row contains the collapsible group headers
              
              Key behaviors:
              1. Each group header uses colSpan to span across all its child columns when expanded
              2. When collapsed, only shows one representative column with colSpan=1
              3. Width is calculated as 120px * colSpan to ensure proper visual alignment
              4. Clicking the header toggles the group's collapsed state
              5. Expanded groups have emphasized styling for clear visual grouping
              6. Expand/collapse all buttons are positioned discretely above the Student Name header
            */}
                <Table.Row>
                  {headerGroups[0].headers
                    .filter(filterHeader)
                    .slice(0, frozenColumnCount)
                    .map((header, colIdx) => (
                      <Table.ColumnHeader
                        key={header.id}
                        bg="bg.subtle"
                        style={{
                          position: "sticky",
                          top: 0,
                          left: colIdx === 0 ? 0 : undefined,
                          zIndex: colIdx === 0 ? 21 : 19,
                          minWidth: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                          width: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                          backgroundColor: "var(--chakra-colors-bg-subtle)"
                        }}
                      >
                        {colIdx === 0 &&
                          Object.keys(groupedColumns).filter((key) => groupedColumns[key].columns.length > 1).length >
                            0 && (
                            <HStack gap={1} justifyContent="flex-end" position="absolute" top={1} right={1} zIndex={22}>
                              <WrappedTooltip content="Auto-layout columns">
                                <IconButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={autoLayout}
                                  colorPalette="blue"
                                  aria-label="Auto-layout columns"
                                  disabled={isAutoLayouting}
                                  _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                                >
                                  {isAutoLayouting ? <Spinner size="xs" /> : <Icon as={LuLayoutGrid} boxSize={3} />}
                                </IconButton>
                              </WrappedTooltip>

                              <WrappedTooltip content="Expand all groups">
                                <IconButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={expandAll}
                                  colorPalette="blue"
                                  aria-label="Expand all groups"
                                >
                                  <Icon as={LuChevronDown} boxSize={3} />
                                </IconButton>
                              </WrappedTooltip>
                              <WrappedTooltip content="Collapse all groups">
                                <IconButton
                                  variant="ghost"
                                  size="sm"
                                  onClick={collapseAll}
                                  colorPalette="blue"
                                  aria-label="Collapse all groups"
                                >
                                  <Icon as={LuChevronRight} boxSize={3} />
                                </IconButton>
                              </WrappedTooltip>
                            </HStack>
                          )}
                      </Table.ColumnHeader>
                    ))}
                  <Table.ColumnHeader
                    key="gradebook-h1-scroll"
                    p={0}
                    bg="bg.subtle"
                    verticalAlign="top"
                    style={{
                      width: scrollableWidth,
                      minWidth: scrollableWidth,
                      maxWidth: scrollableWidth,
                      position: "relative",
                      zIndex: 19
                    }}
                  >
                    <Box position="relative" w={`${scrollableWidth}px`} minH="36px">
                      {scrollableRow1Segments.map((seg) => (
                        <Box
                          key={seg.key}
                          position="absolute"
                          left={`${seg.left}px`}
                          top={0}
                          w={`${seg.width}px`}
                          minH="36px"
                          bg={seg.isCollapsed ? "bg.warning" : "bg.emphasized"}
                          cursor="pointer"
                          onClick={() => toggleGroup(seg.groupName)}
                          _hover={{ bg: "bg.info" }}
                          borderBottom="1px solid"
                          borderColor="border.emphasized"
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                        >
                          <HStack gap={2} justifyContent="center" alignItems="center" py={1}>
                            <Icon
                              as={collapsedGroups.has(seg.groupName) ? LuChevronRight : LuChevronDown}
                              boxSize={3}
                              color="fg.muted"
                            />
                            <Text fontWeight="bold" fontSize="sm" color="fg.muted">
                              {seg.groupColumnsLen}{" "}
                              {pluralize(seg.groupName.charAt(0).toUpperCase() + seg.groupName.slice(1))}
                              ...
                            </Text>
                          </HStack>
                        </Box>
                      ))}
                    </Box>
                  </Table.ColumnHeader>
                </Table.Row>
                {/* Regular header row */}
                {headerGroups.map((headerGroup) => {
                  const row2Filtered = headerGroup.headers.filter(filterHeader);
                  const h2Frozen = row2Filtered.slice(0, frozenColumnCount);
                  const h2Scroll = row2Filtered.slice(frozenColumnCount);
                  return (
                    <Table.Row key={headerGroup.id}>
                      {h2Frozen.map((header, colIdx) => (
                        <Table.ColumnHeader
                          key={header.id}
                          bg="bg.muted"
                          p={0}
                          borderBottom="1px solid"
                          borderLeft="1px solid"
                          borderColor="border.emphasized"
                          verticalAlign="top"
                          data-col-id={header.column.id}
                          style={{
                            position: "sticky",
                            top: 0,
                            left: colIdx === 0 ? 0 : undefined,
                            zIndex: colIdx === 0 ? 21 : 19,
                            minWidth: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                            width: colIdx === 0 ? firstColumnWidth : getColWidth(header.column.id),
                            height: "auto",
                            backgroundColor: "var(--chakra-colors-bg-subtle)"
                          }}
                        >
                          {header.column.id.startsWith("grade_") ? (
                            <GradebookColumnHeader
                              column_id={Number(header.column.id.slice(6))}
                              isSorted={header.column.getIsSorted()}
                              toggleSorting={header.column.toggleSorting}
                              clearSorting={header.column.clearSorting}
                              columnModel={header.column}
                            />
                          ) : header.isPlaceholder ? null : (
                            <GenericGradebookColumnHeader
                              columnName={header.column.id}
                              isSorted={header.column.getIsSorted()}
                              toggleSorting={header.column.toggleSorting}
                              clearSorting={header.column.clearSorting}
                              columnModel={header.column}
                              header={header}
                              coreRowModel={coreRowModel}
                              classSections={classSections?.data}
                              labSections={labSections}
                            />
                          )}
                          {isInstructor && (
                            <ColumnResizeHandle
                              columnId={header.column.id}
                              liveWidthsRef={liveWidthsRef}
                              getColWidth={colIdx === 0 ? () => firstColumnWidth : getColWidth}
                              onResizeEnd={handleColumnResizeEnd}
                            />
                          )}
                        </Table.ColumnHeader>
                      ))}
                      <Table.ColumnHeader
                        key={`${headerGroup.id}-scroll-h2`}
                        p={0}
                        borderBottom="1px solid"
                        borderColor="border.emphasized"
                        verticalAlign="top"
                        style={{
                          width: scrollableWidth,
                          minWidth: scrollableWidth,
                          maxWidth: scrollableWidth,
                          position: "relative",
                          height: "auto",
                          backgroundColor: "var(--chakra-colors-bg-subtle)"
                        }}
                      >
                        {isInstructor && scrollableLeafColumns.length > 0 ? (
                          <Box position="relative" w={`${scrollableWidth}px`} minH={`${leafHeaderHeight}px`}>
                            {Array.from({ length: visibleReorderUnits.length + 1 }, (_, gapIndex) => {
                              let boundary = 0;
                              for (let g = 0; g < gapIndex && g < scrollableLeafColumns.length; g++) {
                                boundary += getColWidth(scrollableLeafColumns[g].id);
                              }
                              return (
                                <GradebookGapDropTarget
                                  key={`gradebook-gap-${gapIndex}`}
                                  gapIndex={gapIndex}
                                  boundaryLeftPx={boundary}
                                  leafHeaderHeight={leafHeaderHeight}
                                  showHitLayer={Boolean(activeDragColumnId)}
                                  lineVisible={activeDropGapIndex === gapIndex}
                                />
                              );
                            })}
                            {columnVirtualizer.getVirtualItems().map((vc) => {
                              const header = h2Scroll[vc.index];
                              if (!header) return null;
                              return (
                                <DraggableGradebookHeaderBox
                                  key={header.id}
                                  header={header}
                                  vc={vc}
                                  leafHeaderHeight={leafHeaderHeight}
                                  coreRowModel={coreRowModel}
                                  classSections={classSections?.data}
                                  labSections={labSections}
                                  showDragHandle
                                  reorderDisabled={isReorderingColumns}
                                  isDraggingThis={activeDragColumnId === header.column.id}
                                  anyColumnDragging={Boolean(activeDragColumnId)}
                                  liveWidthsRef={liveWidthsRef}
                                  getColWidth={getColWidth}
                                  onResizeEnd={handleColumnResizeEnd}
                                />
                              );
                            })}
                          </Box>
                        ) : (
                          <Box position="relative" w={`${scrollableWidth}px`} minH={`${leafHeaderHeight}px`}>
                            {columnVirtualizer.getVirtualItems().map((vc) => {
                              const header = h2Scroll[vc.index];
                              if (!header) return null;
                              return (
                                <Box
                                  key={header.id}
                                  position="absolute"
                                  left={`${vc.start}px`}
                                  top={0}
                                  w={`${vc.size}px`}
                                  role="columnheader"
                                  bg="bg.muted"
                                  px={0}
                                  pt={0}
                                  pb={0}
                                  borderBottom="1px solid"
                                  borderLeft="1px solid"
                                  borderColor="border.emphasized"
                                  verticalAlign="top"
                                  minH={`${leafHeaderHeight}px`}
                                >
                                  {header.column.id.startsWith("grade_") ? (
                                    <GradebookColumnHeader
                                      column_id={Number(header.column.id.slice(6))}
                                      isSorted={header.column.getIsSorted()}
                                      toggleSorting={header.column.toggleSorting}
                                      clearSorting={header.column.clearSorting}
                                      columnModel={header.column}
                                    />
                                  ) : header.isPlaceholder ? null : (
                                    <GenericGradebookColumnHeader
                                      columnName={header.column.id}
                                      isSorted={header.column.getIsSorted()}
                                      toggleSorting={header.column.toggleSorting}
                                      clearSorting={header.column.clearSorting}
                                      columnModel={header.column}
                                      header={header}
                                      coreRowModel={coreRowModel}
                                      classSections={classSections?.data}
                                      labSections={labSections}
                                    />
                                  )}
                                </Box>
                              );
                            })}
                          </Box>
                        )}
                      </Table.ColumnHeader>
                    </Table.Row>
                  );
                })}
              </Table.Header>
              <Table.Body
                style={{
                  height: `${virtualizer.getTotalSize() + (isSafari ? headerHeight || 120 : 0)}px`,
                  position: "relative",
                  margin: 0,
                  padding: 0,
                  borderSpacing: 0,
                  marginTop: 0,
                  paddingTop: 0
                }}
              >
                {virtualRows.map((virtualRow) => renderVirtualRow(virtualRow))}
              </Table.Body>
            </Table.Root>
          </GradebookPointerOpener>
          <DragOverlay dropAnimation={null}>
            {dragOverlayColumn ? (
              <Box
                bg="bg.muted"
                border="1px solid"
                borderColor="border.emphasized"
                borderRadius="md"
                p={2}
                minW={`${GRADE_COL_WIDTH}px`}
                boxShadow="md"
              >
                <Text fontWeight="semibold" fontSize="sm">
                  {dragOverlayColumn.name}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  Max: {dragOverlayColumn.max_score ?? "N/A"}
                </Text>
              </Box>
            ) : null}
          </DragOverlay>
        </DndContext>
      </GradebookPopoverProvider>
      {/* Show row count info */}
      <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
        <Text fontSize="sm" color="fg.muted">
          Showing {rowModel.rows.length} {pluralize("student", rowModel.rows.length)}
        </Text>
        {isInstructor && (
          <HStack gap={2} justifyContent="flex-end" px={4} py={0}>
            <PopoverRoot positioning={{ placement: "top-end" }}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Icon as={FiDownload} mr={2} /> Download Gradebook
                </Button>
              </PopoverTrigger>
              <PopoverContent maxW="300px">
                <PopoverBody p={3}>
                  <VStack align="start" gap={3}>
                    <Checkbox
                      checked={exportWithRenderExpressions}
                      onCheckedChange={(details) => setExportWithRenderExpressions(details.checked === true)}
                    >
                      Use render expressions in CSV
                    </Checkbox>
                    <Button size="sm" variant="subtle" colorPalette="green" onClick={downloadGradebookCsv}>
                      Download CSV
                    </Button>
                  </VStack>
                </PopoverBody>
              </PopoverContent>
            </PopoverRoot>
            <ImportGradebookColumn />
            <AddColumnDialog />
          </HStack>
        )}
      </HStack>
    </VStack>
  );
}
