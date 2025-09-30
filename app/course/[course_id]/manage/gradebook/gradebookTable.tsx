"use client";

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
  Float,
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
  filterFns,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  Header,
  RowModel,
  useReactTable
} from "@tanstack/react-table";
import { useVirtualizer, VirtualItem } from "@tanstack/react-virtual";
import { Select } from "chakra-react-select";
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
  LuLayoutGrid,
  LuPencil,
  LuTrash,
  LuX
} from "react-icons/lu";
import { TbEye, TbEyeOff, TbFilter } from "react-icons/tb";
import { WhatIf } from "../../gradebook/whatIf";
import GradebookCell from "./gradebookCell";
import { GradebookPopoverProvider } from "./GradebookPopoverProvider";
import ImportGradebookColumn from "./importGradebookColumn";
import { LucideInfo } from "lucide-react";
const MemoizedGradebookCell = React.memo(GradebookCell);

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
  };

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<FormValues>({
    defaultValues: {
      name: "",
      description: "",
      maxScore: 0,
      slug: "",
      scoreExpression: "",
      renderExpression: ""
    }
  });

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
      showCalculatedRanges: column?.show_calculated_ranges ?? false
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
        showCalculatedRanges: column.show_calculated_ranges ?? false
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
                        await gradebookController.gradebook_columns.delete(columnId);
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

function ExteralDataAdvice({ externalData }: { externalData: GradebookColumnExternalData }) {
  return (
    <VStack gap={0} align="flex-start">
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Imported from CSV
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        File: {externalData.fileName}
      </Text>
      <Text fontSize="sm" color="fg.default" fontWeight="medium">
        Date: {new Date(externalData.date).toLocaleDateString()}
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
  values,
  columnModel,
  isOpen,
  onClose,
  triggerRef
}: {
  columnName: string;
  values: GradebookColumnStudent[];
  columnModel: Column<UserProfile, unknown>;
  isOpen: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement>;
}) {
  const uniqueValues = useMemo(() => {
    //TODO maybe one day revisit so that the filter contains the letter grades, but will require some refactoring of filtering.
    return [...new Set(values.map((grade) => grade.score_override ?? grade.score))] as number[];
  }, [values]);

  const selectOptions = useMemo(
    () => uniqueValues.map((value) => ({ label: String(value), value: String(value) })),
    [uniqueValues]
  );

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
  rowModel,
  classSections,
  labSections
}: {
  columnName: string;
  isSorted: "asc" | "desc" | false;
  toggleSorting: (direction: boolean) => void;
  clearSorting: () => void;
  columnModel: Column<UserProfile, unknown>;
  header: Header<UserProfile, unknown>;
  rowModel: RowModel<UserProfile>;
  classSections?: ClassSection[];
  labSections?: LabSection[];
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
        p={1.5}
        pr={3}
        bg="bg.surface"
        borderBottom="1px solid"
        borderColor="border.muted"
        minH="32px"
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        alignItems="stretch"
      >
        {/* Action buttons - always in same position */}
        <Float placement="top-end" offsetX={2} offsetY={2}>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton size="2xs" variant="surface" aria-label="Column options">
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
        </Float>
        {/* Column name and action buttons */}
        <Text fontWeight="semibold" fontSize="sm" color="fg.default" style={{ userSelect: "none" }} lineHeight="tight">
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
            rowModel={rowModel}
          />
        )}
      </Box>
      <HStack alignItems="flex-end" w="100%">
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
  columnModel
}: {
  column_id: number;
  isSorted: "asc" | "desc" | false;
  toggleSorting: (direction: boolean) => void;
  clearSorting: () => void;
  columnModel: Column<UserProfile, unknown>;
}) {
  const column = useGradebookColumn(column_id);
  const gradebookController = useGradebookController();
  const areAllDependenciesReleased = useAreAllDependenciesReleased(column_id);
  const allGrades = useGradebookColumnGrades(column_id);

  // Check for mixed release status (some students have released grades, others don't)
  const hasMixedReleaseStatus = useMemo(() => {
    if (!column.score_expression || allGrades.length === 0) return false;

    const releasedCount = allGrades.filter((grade) => grade.released).length;
    const totalCount = allGrades.length;

    // Mixed status: some but not all grades are released
    return releasedCount > 0 && releasedCount < totalCount;
  }, [column.score_expression, allGrades]);
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

  const moveLeft = useCallback(async () => {
    if (column.sort_order == null || column.sort_order === 0) return;

    setIsMovingLeft(true);
    try {
      const { error } = await supabase.rpc("gradebook_column_move_left", {
        p_column_id: column_id
      });

      if (error) throw error;
      await gradebookController.gradebook_columns.refetchAll();

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
      setIsMovingLeft(false);
    }
  }, [column_id, column, supabase, gradebookController]);

  const moveRight = useCallback(async () => {
    if (column.sort_order == null) return;

    setIsMovingRight(true);
    try {
      const { error } = await supabase.rpc("gradebook_column_move_right", {
        p_column_id: column_id
      });

      if (error) throw error;

      await gradebookController.gradebook_columns.refetchAll();

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
      setIsMovingRight(false);
    }
  }, [column_id, column, supabase, gradebookController]);

  const releaseColumn = useCallback(async () => {
    setIsReleasing(true);
    try {
      const { error } = await supabase.from("gradebook_columns").update({ released: true }).eq("id", column_id);

      if (error) throw error;

      await gradebookController.gradebook_columns.refetchAll();

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

      await gradebookController.gradebook_columns.refetchAll();

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
        p={1.5}
        pr={3}
        pb={0}
        bg="bg.surface"
        borderBottom="1px solid"
        borderColor="border.muted"
        minH="32px"
        display="flex"
        flexDirection="column"
        justifyContent="space-between"
        alignItems="stretch"
      >
        {/* Column name and status indicators */}
        {/* Action buttons - floating to create text wrap */}
        <Float placement="top-end" offsetX={2} offsetY={2}>
          <MenuRoot>
            <MenuTrigger asChild>
              <IconButton size="2xs" variant="surface" aria-label="Column options">
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
              {!column.score_expression && (
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
        </Float>

        <WrappedTooltip content={toolTipText}>
          <Text
            fontWeight="semibold"
            fontSize="sm"
            color="fg.default"
            style={{ userSelect: "none", float: "left" }}
            lineHeight="tight"
          >
            {column.name}
          </Text>
        </WrappedTooltip>
        {/* Filter section - only shown when toggled */}
        {showFilter && (
          <GradebookColumnFilter
            columnName={column.name}
            values={allGrades}
            columnModel={columnModel}
            isOpen={showFilter}
            onClose={() => setShowFilter(false)}
            triggerRef={headerRef}
          />
        )}
        {/* Status indicators and max score on same line */}
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
                        <ExteralDataAdvice externalData={column.external_data as GradebookColumnExternalData} />
                      </Tooltip.Content>
                    </Tooltip.Positioner>
                  </Portal>
                </Tooltip.Root>
              </Box>
            )}
            {column.score_expression ? (
              <Box position="relative" zIndex={10000}>
                <WrappedTooltip content="Visibility: Students see this value calculated based on released dependencies">
                  <Icon as={LucideInfo} size="sm" color="blue.500" />
                </WrappedTooltip>
              </Box>
            ) : gradebookController.isColumnEffectivelyReleased(column_id) ? (
              <Box position="relative" zIndex={100}>
                <WrappedTooltip content="Effectively released to students (either released or all grades are null)">
                  <Icon as={FaLockOpen} size="sm" color="green.500" />
                </WrappedTooltip>
              </Box>
            ) : (
              <Box position="relative" zIndex={100}>
                <WrappedTooltip content="Not effectively released to students">
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
    </VStack>
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
  const isInstructor = useIsInstructor();
  const isRefetching = useGradebookRefetchStatus();
  const isGradebookDataReady = useIsGradebookDataReady();

  // State for collapsible groups - use base group name as key for stability
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [isAutoLayouting, setIsAutoLayouting] = useState(false);

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
        cell: ({ row }) => <StudentNameCell uid={row.original.id} />,
        enableColumnFilter: true,
        filterFn: filterFns.includesString,
        enableSorting: true
      }
    ];

    // Only add class section column if there are class sections
    if (classSections?.data && classSections.data.length > 0) {
      cols.push({
        id: "class_section",
        header: "Class Section",
        accessorFn: (row) => profileIdToSectionData[row.id]?.classSection?.name ?? "No Section",
        cell: ({ row }) => (
          <Text fontSize="sm">{profileIdToSectionData[row.original.id]?.classSection?.name ?? "No Section"}</Text>
        ),
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
        cell: ({ row }) => (
          <Text fontSize="sm">{profileIdToSectionData[row.original.id]?.labSection?.name ?? "No Lab Section"}</Text>
        ),
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
          accessorFn: (row) => {
            const controller = gradebookController.getStudentGradebookController(row.id);
            const { item } = controller.getColumnForStudent(col.id);
            // Always return a string for filtering
            return String(item?.score_override ?? item?.score ?? "missing");
          },
          cell: ({ row }) => {
            return <MemoizedGradebookCell columnId={col.id} studentId={row.original.id} />;
          },
          enableColumnFilter: true,
          filterFn: (row, columnId, filterValue) => {
            const controller = gradebookController.getStudentGradebookController(row.original.id);
            return controller.filter(col.id, filterValue);
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
            accessorFn: (row) => {
              const controller = gradebookController.getStudentGradebookController(row.id);
              const { item } = controller.getColumnForStudent(col.id);
              // Always return a string for filtering
              return String(item?.score_override ?? item?.score ?? "missing");
            },
            cell: ({ row }) => {
              return <MemoizedGradebookCell columnId={col.id} studentId={row.original.id} />;
            },
            enableColumnFilter: true,
            filterFn: (row, columnId, filterValue) => {
              const controller = gradebookController.getStudentGradebookController(row.original.id);
              return controller.filter(col.id, filterValue);
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
    labSections
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

  // Virtualization setup
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLTableSectionElement>(null);

  // Dynamic first column width calculation
  const [firstColumnWidth, setFirstColumnWidth] = useState(180); // Default width

  // Header height state for Safari compatibility
  const [headerHeight, setHeaderHeight] = useState(0);

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

  // Calculate header height after render and when columns/groups change
  useEffect(() => {
    calculateHeaderHeight();
  }, [calculateHeaderHeight, gradebookColumns.length, groupedColumns, collapsedGroups]);

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

  const virtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 45, // Estimated row height in pixels
    overscan: 150 // Number of items to render outside visible area
  });

  const virtualRows = virtualizer.getVirtualItems();

  const renderVirtualRow = useCallback(
    (virtualRow: VirtualItem) => {
      const row = rowModel.rows[virtualRow.index];
      if (!row) return null;

      const idx = virtualRow.index;

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
          {row.getVisibleCells().map((cell, colIdx) => {
            const isCollapsedColumn = (cell.column.columnDef.meta as { isCollapsed?: boolean })?.isCollapsed;

            return (
              <Table.Cell
                key={cell.id}
                p={2}
                position="relative"
                bg={
                  colIdx === 0
                    ? idx % 2 === 0
                      ? "bg.subtle"
                      : "bg.muted"
                    : isCollapsedColumn
                      ? "bg.warning"
                      : undefined
                }
                style={{
                  ...(colIdx === 0
                    ? {
                        position: "sticky",
                        left: 0,
                        zIndex: 18,
                        borderRight: "1px solid var(--chakra-colors-border-muted)",
                        width: `${firstColumnWidth}px`,
                        maxWidth: `${firstColumnWidth}px`,
                        minWidth: `${firstColumnWidth}px`
                      }
                    : {
                        width: "120px",
                        maxWidth: "120px",
                        minWidth: "120px",
                        zIndex: 1
                      }),
                  ...(isCollapsedColumn
                    ? {
                        borderLeft: "2px solid var(--chakra-colors-border-warning)"
                      }
                    : {}),
                  height: `${virtualRow.size}px`,
                  verticalAlign: "middle",
                  display: "table-cell",
                  boxSizing: "border-box"
                }}
                className={colIdx === 0 ? "sticky-first-cell" : undefined}
              >
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
                <Box pl={isCollapsedColumn ? 8 : 0}>
                  {cell.column.columnDef.cell
                    ? flexRender(cell.column.columnDef.cell, cell.getContext())
                    : String(cell.getValue())}
                </Box>
              </Table.Cell>
            );
          })}
        </Table.Row>
      );
    },
    [rowModel.rows, toggleGroup, firstColumnWidth, headerHeight, isSafari]
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
        tr:hover .sticky-first-cell {
          background-color: var(--chakra-colors-bg-info) !important;
        }
      `}</style>
      <Toaster />
      <StudentDetailDialog />
      <GradebookPopoverProvider>
        <Box
          ref={parentRef}
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
            minW="100%"
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
                  .filter((header) => {
                    // Filter out headers that should be hidden when collapsed
                    if (header.column.id.startsWith("grade_")) {
                      const columnId = Number(header.column.id.slice(6));
                      const column = gradebookColumns.find((col) => col.id === columnId);

                      if (column) {
                        const prefix = column.slug.split("-")[0];
                        const baseGroupName = prefix || "other";

                        // Find the group this column belongs to
                        const groupEntry = Object.entries(groupedColumns).find(
                          ([key, group]) =>
                            key.startsWith(baseGroupName) && group.columns.some((col) => col.id === columnId)
                        );

                        if (groupEntry && groupEntry[1].columns.length > 1) {
                          const isCollapsed = collapsedGroups.has(groupEntry[1].groupName);

                          if (isCollapsed) {
                            // When collapsed, only show the best column to show
                            const bestColumn = findBestColumnToShow(groupEntry[1].columns);
                            return columnId === bestColumn.id;
                          }
                        }
                      }
                    }
                    return true; // Show all non-gradebook columns and single-column groups
                  })
                  .map((header, colIdx) => {
                    if (header.column.id.startsWith("grade_")) {
                      // Find which group this column belongs to
                      const columnId = Number(header.column.id.slice(6));
                      const column = gradebookColumns.find((col) => col.id === columnId);

                      if (column) {
                        const prefix = column.slug.split("-")[0];
                        const baseGroupName = prefix || "other";

                        // Find the group this column belongs to
                        const groupEntry = Object.entries(groupedColumns).find(
                          ([key, group]) =>
                            key.startsWith(baseGroupName) && group.columns.some((col) => col.id === columnId)
                        );

                        if (groupEntry && groupEntry[1].columns.length > 1) {
                          // Check if this is the first column in its group
                          const groupColumns = groupEntry[1].columns;
                          const isFirstInGroup = groupColumns[0].id === columnId;
                          const isCollapsed = collapsedGroups.has(groupEntry[1].groupName);

                          // When collapsed, check if this is the column that was selected to be shown
                          const isVisibleInCollapsedGroup = isCollapsed
                            ? findBestColumnToShow(groupColumns).id === columnId
                            : isFirstInGroup;

                          // Show group header for first column when expanded, or for the visible column when collapsed
                          if (isFirstInGroup || (isCollapsed && isVisibleInCollapsedGroup)) {
                            // Calculate the number of columns this header should span
                            // - When collapsed: span only 1 column (the representative column)
                            // - When expanded: span all columns in the group for proper visual grouping
                            const colSpan = isCollapsed ? 1 : groupColumns.length;

                            return (
                              <Table.ColumnHeader
                                key={header.id}
                                colSpan={colSpan}
                                bg={isCollapsed ? "bg.warning" : "bg.emphasized"}
                                cursor="pointer"
                                onClick={() => toggleGroup(groupEntry[1].groupName)}
                                _hover={{ bg: "bg.info" }}
                                style={{
                                  position: "sticky",
                                  // Add emphasized border when expanded to show clear grouping
                                  borderBottom: "1px solid var(--chakra-colors-border-emphasized)",
                                  top: 0,
                                  zIndex: 19,
                                  textAlign: "center",
                                  // When expanded, width should span all columns; when collapsed, just one column
                                  width: isCollapsed ? "120px" : `${120 * groupColumns.length}px`,
                                  minWidth: isCollapsed ? "120px" : `${120 * groupColumns.length}px`,
                                  maxWidth: isCollapsed ? "120px" : `${120 * groupColumns.length}px`,
                                  backgroundColor: isCollapsed
                                    ? "var(--chakra-colors-bg-warning)"
                                    : "var(--chakra-colors-bg-emphasized)"
                                }}
                              >
                                <HStack gap={2} justifyContent="center" alignItems="center" py={1}>
                                  <Icon
                                    as={collapsedGroups.has(groupEntry[1].groupName) ? LuChevronRight : LuChevronDown}
                                    boxSize={3}
                                    color="fg.muted"
                                  />
                                  <Text fontWeight="bold" fontSize="sm" color="fg.muted">
                                    {groupEntry[1].columns.length}{" "}
                                    {pluralize(
                                      groupEntry[1].groupName.charAt(0).toUpperCase() + groupEntry[1].groupName.slice(1)
                                    )}
                                    ...
                                  </Text>
                                </HStack>
                              </Table.ColumnHeader>
                            );
                          } else if (!isCollapsed) {
                            // When expanded, skip non-first columns as they're covered by the group header's colspan
                            return null;
                          } else {
                            // When collapsed, this column should not be rendered at all (filtered out earlier)
                            return null;
                          }
                        }
                      }
                    }

                    return (
                      <Table.ColumnHeader
                        key={header.id}
                        bg="bg.subtle"
                        style={{
                          position: "sticky",
                          top: 0,
                          left: colIdx === 0 ? 0 : undefined,
                          zIndex: colIdx === 0 ? 21 : 19,
                          minWidth: colIdx === 0 ? firstColumnWidth : 120,
                          width: colIdx === 0 ? firstColumnWidth : 120,
                          backgroundColor: "var(--chakra-colors-bg-subtle)"
                        }}
                      >
                        {/* Add expand/collapse buttons in the space above Student Name */}
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
                    );
                  })}
              </Table.Row>
              {/* Regular header row */}
              {headerGroups.map((headerGroup) => (
                <Table.Row key={headerGroup.id}>
                  {headerGroup.headers
                    .filter((header) => {
                      // Filter out headers that should be hidden when collapsed
                      if (header.column.id.startsWith("grade_")) {
                        const columnId = Number(header.column.id.slice(6));
                        const column = gradebookColumns.find((col) => col.id === columnId);

                        if (column) {
                          const prefix = column.slug.split("-")[0];
                          const baseGroupName = prefix || "other";

                          // Find the group this column belongs to
                          const groupEntry = Object.entries(groupedColumns).find(
                            ([key, group]) =>
                              key.startsWith(baseGroupName) && group.columns.some((col) => col.id === columnId)
                          );

                          if (groupEntry && groupEntry[1].columns.length > 1) {
                            const isCollapsed = collapsedGroups.has(groupEntry[1].groupName);

                            if (isCollapsed) {
                              // When collapsed, only show the best column to show
                              const bestColumn = findBestColumnToShow(groupEntry[1].columns);
                              return columnId === bestColumn.id;
                            }
                          }
                        }
                      }
                      return true; // Show all non-gradebook columns and single-column groups
                    })
                    .map((header, colIdx) => (
                      <Table.ColumnHeader
                        key={header.id}
                        bg="bg.muted"
                        p={2}
                        pb={0}
                        borderBottom="1px solid"
                        borderLeft="1px solid"
                        borderColor="border.emphasized"
                        verticalAlign="top"
                        style={{
                          position: "sticky",
                          top: 0,
                          left: colIdx === 0 ? 0 : undefined,
                          zIndex: colIdx === 0 ? 21 : 19,
                          minWidth: colIdx === 0 ? firstColumnWidth : 120,
                          width: colIdx === 0 ? firstColumnWidth : 120,
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
                            rowModel={rowModel}
                            classSections={classSections?.data}
                            labSections={labSections}
                          />
                        )}
                      </Table.ColumnHeader>
                    ))}
                </Table.Row>
              ))}
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
        </Box>
      </GradebookPopoverProvider>
      {/* Show row count info */}
      <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
        <Text fontSize="sm" color="fg.muted">
          Showing {rowModel.rows.length} {pluralize("student", rowModel.rows.length)}
        </Text>
        {isInstructor && (
          <HStack gap={2} justifyContent="flex-end" px={4} py={0}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const csv = gradebookController.exportGradebook(courseController);
                const blob = new Blob(
                  [
                    csv
                      .map((row) =>
                        row.map((cell) => (typeof cell === "string" ? `"${cell.replace(/"/g, "")}"` : cell)).join(",")
                      )
                      .join("\n")
                  ],
                  { type: "text/csv" }
                );
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "gradebook.csv";
                a.click();
              }}
            >
              <Icon as={FiDownload} mr={2} /> Download Gradebook
            </Button>
            <ImportGradebookColumn />
            <AddColumnDialog />
          </HStack>
        )}
      </HStack>
    </VStack>
  );
}
