"use client";

import { Label } from "@/components/ui/label";
import { MenuContent, MenuItem, MenuRoot, MenuTrigger } from "@/components/ui/menu";
import PersonName from "@/components/ui/person-name";
import { Toaster, toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { useClassProfiles, useIsInstructor, useStudentRoster } from "@/hooks/useClassProfiles";
import {
  useCanShowGradeFor,
  useCourseController,
  useObfuscatedGradesMode,
  useSetOnlyShowGradesFor
} from "@/hooks/useCourseController";
import {
  useGradebookColumn,
  useGradebookColumns,
  useGradebookController,
  useStudentDetailView
} from "@/hooks/useGradebook";
import { createClient } from "@/utils/supabase/client";
import { GradebookColumn, UserProfile } from "@/utils/supabase/DatabaseTypes";
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
  Portal,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useCreate, useInvalidate, useUpdate } from "@refinedev/core";
import { useForm } from "@refinedev/react-hook-form";
import {
  Column,
  ColumnDef,
  filterFns,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FieldValues } from "react-hook-form";
import { FiDownload, FiMoreVertical, FiPlus } from "react-icons/fi";
import { LuArrowDown, LuArrowLeft, LuArrowRight, LuArrowUp, LuCheck, LuPencil, LuTrash } from "react-icons/lu";
import { TbEye, TbEyeOff } from "react-icons/tb";
import { WhatIf } from "../../gradebook/whatIf";
import GradebookCell from "./gradebookCell";
import ImportGradebookColumn from "./importGradebookColumn";
const MemoizedGradebookCell = React.memo(GradebookCell);

function RenderExprDocs() {
  return (
    <Text fontSize="sm" color="fg.muted">
      Refers to the score as variable <Code>score</Code>. Convert to letter with <Code>letter(score)</Code>
      See{" "}
      <Link href="https://mathjs.org/examples/index.html" target="_blank">
        mathjs documentation
      </Link>
    </Text>
  );
}
function ScoreExprDocs() {
  return (
    <Text fontSize="sm" color="fg.muted">
      Reference a gradebook column or assignment with <Code>gradebook_columns(&quot;slug&quot;)</Code> or{" "}
      <Code>assignments(&quot;slug&quot;)</Code>, globs supported See{" "}
      <Link href="https://mathjs.org/examples/index.html" target="_blank">
        mathjs documentation
      </Link>
    </Text>
  );
}
function AddColumnDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const gradebookController = useGradebookController();
  const { mutateAsync: createColumn } = useCreate<GradebookColumn>({
    resource: "gradebook_columns"
  });
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
    setError,
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
    const loadingToast = toaster.loading({
      title: "Saving...",
      description: "This may take a few seconds to recalculate..."
    });
    setIsLoading(true);
    try {
      const dependencies = gradebookController.extractAndValidateDependencies(data.scoreExpression ?? "", -1);
      await createColumn({
        resource: "gradebook_columns",
        values: {
          name: data.name,
          description: data.description,
          max_score: data.maxScore,
          slug: data.slug,
          score_expression: data.scoreExpression?.length ? data.scoreExpression : null,
          render_expression: data.renderExpression?.length ? data.renderExpression : null,
          dependencies,
          class_id: gradebookController.gradebook.class_id,
          gradebook_id: gradebookController.gradebook.id,
          sort_order: gradebookController.gradebook.gradebook_columns.length
        }
      });
      setIsLoading(false);
      toaster.dismiss(loadingToast);
      setIsOpen(false);
    } catch (e) {
      toaster.dismiss(loadingToast);
      setIsLoading(false);
      let message = "An unknown error occurred";
      if (e && typeof e === "object" && "message" in e && typeof (e as { message?: string }).message === "string") {
        message = (e as { message: string }).message;
      }
      setError("root", { message });
    }
  };

  return (
    <Dialog.Root open={isOpen} size={"md"} placement={"center"}>
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
                  <Input id="scoreExpression" {...register("scoreExpression")} placeholder="Score Expression" />
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
  const invalidate = useInvalidate();
  const [isLoading, setIsLoading] = useState(false);
  const column = useGradebookColumn(columnId);

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
    setError,
    formState: { errors }
  } = useForm<FormValues>({
    defaultValues: {
      name: column?.name ?? "",
      description: column?.description ?? "",
      maxScore: column?.max_score ?? 0,
      slug: column?.slug ?? "",
      scoreExpression: column?.score_expression ?? "",
      renderExpression: column?.render_expression ?? ""
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
        renderExpression: column.render_expression ?? ""
      });
    }
  }, [columnId, column, reset]);

  if (!columnId) return null;
  if (!column) throw new Error(`Column ${columnId} not found`);

  const onSubmit = async (data: FieldValues) => {
    const loadingToast = toaster.loading({
      title: "Saving...",
      description: "This may take a few seconds to recalculate..."
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
          dependencies
        }
      });
      await invalidate({
        resource: "gradebook_columns",
        id: columnId,
        invalidates: ["all"]
      });
      setIsLoading(false);
      toaster.dismiss(loadingToast);
      onClose();
    } catch (e) {
      toaster.dismiss(loadingToast);
      setIsLoading(false);
      let message = "An unknown error occurred";
      if (e && typeof e === "object" && "message" in e && typeof (e as { message?: string }).message === "string") {
        message = (e as { message: string }).message;
      }
      setError("root", { message });
    }
  };

  return (
    <Dialog.Root open={true} size={"md"} placement={"center"}>
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
                  <Input id="slug" {...register("slug", { required: "Slug is required" })} placeholder="Slug" />
                  {errors.slug && (
                    <Text color="red.500" fontSize="sm">
                      {errors.slug.message as string}
                    </Text>
                  )}
                </Box>
                <Box>
                  <Label htmlFor="scoreExpression">Score Expression</Label>
                  <Input id="scoreExpression" {...register("scoreExpression")} placeholder="Score Expression" />
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

function DeleteColumnDialog({ columnId, onClose }: { columnId: number; onClose: () => void }) {
  const supabase = createClient();
  const invalidate = useInvalidate();
  const [isDeleting, setIsDeleting] = useState(false);
  const columns = useGradebookColumns();
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
    <Dialog.Root open={true} size={"md"} placement={"center"}>
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
                        await supabase.from("gradebook_columns").delete().eq("id", columnId);
                        await invalidate({
                          resource: "gradebook_columns",
                          invalidates: ["all"]
                        });
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

function GradebookColumnHeader({
  column_id,
  renderColumnFilter,
  isSorted,
  toggleSorting,
  clearSorting,
  columnModel
}: {
  column_id: number;
  renderColumnFilter: (column: Column<UserProfile, unknown>) => React.ReactNode;
  isSorted: "asc" | "desc" | false;
  toggleSorting: (direction: boolean) => void;
  clearSorting: () => void;
  columnModel: Column<UserProfile, unknown>;
}) {
  const column = useGradebookColumn(column_id);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const supabase = createClient();
  const invalidate = useInvalidate();
  const moveLeft = useCallback(async () => {
    if (column.sort_order === 0) return;
    await supabase
      .from("gradebook_columns")
      .update({
        sort_order: column.sort_order
      })
      .eq("gradebook_id", column.gradebook_id)
      .eq("sort_order", column.sort_order - 1);
    await supabase
      .from("gradebook_columns")
      .update({
        sort_order: column.sort_order - 1
      })
      .eq("id", column_id);
    await invalidate({
      resource: "gradebook_columns",
      id: column_id,
      invalidates: ["all"]
    });
  }, [column_id, column, invalidate, supabase]);
  const moveRight = useCallback(async () => {
    await supabase
      .from("gradebook_columns")
      .update({
        sort_order: column.sort_order
      })
      .eq("gradebook_id", column.gradebook_id)
      .eq("sort_order", column.sort_order + 1);
    await supabase
      .from("gradebook_columns")
      .update({
        sort_order: column.sort_order + 1
      })
      .eq("id", column_id);
  }, [columnModel]);
  const toolTipText = useMemo(() => {
    const ret: string[] = [];
    if (column.description) {
      ret.push(`Description: ${column.description}`);
    }
    if (column.score_expression) {
      ret.push(`Auto-calculated using: ${column.score_expression}`);
    }
    if (column.render_expression) {
      ret.push(`Rendered as ${column.render_expression}`);
    }
    if (column.released) {
      ret.push("Released to students");
    } else {
      ret.push("Not released to students");
    }
    return (
      <VStack gap={0} align="flex-start">
        {ret.map((t) => (
          <Text key={t}>{t}</Text>
        ))}
      </VStack>
    );
  }, [column]);
  return (
    <VStack gap={1} alignItems="flex-start">
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
      <HStack gap={1} justifyContent="space-between" w="100%">
        <Tooltip content={toolTipText}>
          <span style={{ userSelect: "none" }}>{column.name}</span>
        </Tooltip>
        <MenuRoot>
          <MenuTrigger asChild>
            <Button size="xs" variant="ghost" aria-label="Column options" px={1}>
              <Icon as={FiMoreVertical} boxSize={3} />
            </Button>
          </MenuTrigger>
          <MenuContent minW="120px">
            <MenuItem value="asc" onClick={() => toggleSorting(false)}>
              {isSorted === "asc" && <Icon as={LuCheck} boxSize={3} mr={1} />}
              <Icon as={LuArrowUp} boxSize={3} mr={1} />
              Sort Ascending
            </MenuItem>
            <MenuItem value="desc" onClick={() => toggleSorting(true)}>
              {isSorted === "desc" && <Icon as={LuCheck} boxSize={3} mr={1} />}
              <Icon as={LuArrowDown} boxSize={3} mr={1} />
              Sort Descending
            </MenuItem>
            {isSorted && (
              <MenuItem value="clear" onClick={() => clearSorting()}>
                Clear Sort
              </MenuItem>
            )}
            <MenuItem value="edit" onClick={() => setIsEditing(true)}>
              <Icon as={LuPencil} boxSize={3} mr={1} />
              Edit Column
            </MenuItem>
            <MenuItem value="moveLeft" onClick={moveLeft}>
              <Icon as={LuArrowLeft} boxSize={3} mr={1} />
              Move Left
            </MenuItem>
            <MenuItem value="moveRight" onClick={moveRight}>
              <Icon as={LuArrowRight} boxSize={3} mr={1} />
              Move Right
            </MenuItem>
            <MenuItem
              value="delete"
              onClick={() => setIsDeleting(true)}
              color="fg.error"
              _hover={{ bg: "bg.error", color: "fg.error" }}
            >
              <Icon as={LuTrash} boxSize={3} mr={1} />
              Delete Column
            </MenuItem>
          </MenuContent>
        </MenuRoot>
      </HStack>
      {renderColumnFilter(columnModel)}
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
        <PersonName uid={uid} size="2xs" />
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
    <Dialog.Root open={!!view} onOpenChange={(details) => (!details.open ? setView(null) : undefined)}>
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
            {view && <WhatIf private_profile_id={view} />}
          </Dialog.Body>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
export default function GradebookTable() {
  const rawStudents = useStudentRoster();
  const courseController = useCourseController();
  const students = useMemo(() => rawStudents, [rawStudents]);
  const gradebookController = useGradebookController();
  const { allVisibleRoles } = useClassProfiles();
  const gradebookColumns = useGradebookColumns();
  const gradebook = gradebookController.gradebook;
  const isInstructor = useIsInstructor();
  // Map profile id to section id
  const profileIdToSectionId = useMemo(() => {
    const map: Record<string, number | null> = {};
    allVisibleRoles.forEach((role) => {
      if (role.role === "student") {
        map[role.private_profile_id] = role.class_section_id ?? null;
      }
    });
    return map;
  }, [allVisibleRoles]);

  // Build columns
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
      },
      {
        id: "student_section",
        header: "Section",
        accessorFn: (row) => profileIdToSectionId[row.id] ?? "",
        enableColumnFilter: true,
        filterFn: filterFns.includesString,
        enableSorting: true
      }
    ];
    gradebookColumns.sort((a, b) => a.sort_order - b.sort_order);
    gradebookColumns.forEach((col) => {
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
    });
    return cols;
  }, [profileIdToSectionId, gradebookController, gradebookColumns]);

  // Table instance
  const table = useReactTable({
    data: students,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      pagination: { pageIndex: 0, pageSize: 50 },
      sorting: [{ id: "student_name", desc: false }]
    }
  });

  // Helper for rendering column filter input
  function renderColumnFilter(column: Column<UserProfile, unknown>) {
    if (!column.getCanFilter()) return null;
    return (
      <Input
        mt={1}
        size="sm"
        placeholder={`Filter ${typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}`}
        value={String(column.getFilterValue() ?? "")}
        onChange={(e) => column.setFilterValue(e.target.value)}
        aria-label={`Filter by ${typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}`}
      />
    );
  }

  const headerGroups = table.getHeaderGroups();
  const rowModel = table.getRowModel();
  const pageCount = table.getPageCount();
  const state = table.getState();
  const setPageIndex = table.setPageIndex;
  const previousPage = table.previousPage;
  const nextPage = table.nextPage;
  const getCanPreviousPage = table.getCanPreviousPage;
  const getCanNextPage = table.getCanNextPage;

  const rows = useMemo(() => {
    return rowModel.rows.map((row, idx) => (
      <Table.Row key={row.id} bg={idx % 2 === 0 ? "bg.subtle" : "bg.muted"} _hover={{ bg: "bg.info" }}>
        {row.getVisibleCells().map((cell, colIdx) => (
          <Table.Cell
            key={cell.id}
            p={0}
            bg={colIdx === 0 ? (idx % 2 === 0 ? "bg.subtle" : "bg.muted") : undefined}
            style={
              colIdx === 0
                ? {
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    borderRight: "1px solid",
                    borderColor: "border.muted"
                  }
                : {}
            }
            className={colIdx === 0 ? "sticky-first-cell" : undefined}
          >
            {cell.column.columnDef.cell
              ? flexRender(cell.column.columnDef.cell, cell.getContext())
              : String(cell.getValue())}
          </Table.Cell>
        ))}
      </Table.Row>
    ));
  }, [rowModel.rows]);

  if (!students || !gradebook || !gradebookController.isReady) {
    return <Spinner />;
  }

  return (
    <VStack align="stretch" w="100%" gap={0}>
      <style jsx global>{`
        tr:hover .sticky-first-cell {
          background-color: var(--chakra-colors-bg-info) !important;
        }
      `}</style>
      <Toaster />
      <StudentDetailDialog />
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
      <Box overflowX="auto" maxW="100vw" maxH="100vh" overflowY="auto">
        <Table.Root minW="0">
          <Table.Header>
            {headerGroups.map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header, colIdx) => (
                  <Table.ColumnHeader
                    key={header.id}
                    bg="bg.muted"
                    style={{
                      position: "sticky",
                      top: 0,
                      left: colIdx === 0 ? 0 : undefined,
                      zIndex: colIdx === 0 ? 21 : 20,
                      minWidth: colIdx === 0 ? 180 : undefined,
                      width: colIdx === 0 ? 180 : undefined
                    }}
                  >
                    {header.column.id.startsWith("grade_") ? (
                      <GradebookColumnHeader
                        column_id={Number(header.column.id.slice(6))}
                        isSorted={header.column.getIsSorted()}
                        toggleSorting={header.column.toggleSorting}
                        clearSorting={header.column.clearSorting}
                        renderColumnFilter={renderColumnFilter}
                        columnModel={header.column}
                      />
                    ) : header.isPlaceholder ? null : (
                      <>
                        <HStack gap={1} alignItems="center">
                          <span style={{ userSelect: "none" }}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </span>
                          {header.column.getCanSort() && (
                            <MenuRoot>
                              <MenuTrigger asChild>
                                <Button size="xs" variant="ghost" aria-label="Sort options" px={1}>
                                  <Icon as={FiMoreVertical} boxSize={3} />
                                </Button>
                              </MenuTrigger>
                              <MenuContent minW="120px">
                                <MenuItem value="asc" onClick={() => header.column.toggleSorting(false)}>
                                  {header.column.getIsSorted() === "asc" && <Icon as={LuCheck} boxSize={3} mr={1} />}
                                  <Icon as={LuArrowUp} boxSize={3} mr={1} />
                                  Sort Ascending
                                </MenuItem>
                                <MenuItem value="desc" onClick={() => header.column.toggleSorting(true)}>
                                  {header.column.getIsSorted() === "desc" && <Icon as={LuCheck} boxSize={3} mr={1} />}
                                  <Icon as={LuArrowDown} boxSize={3} mr={1} />
                                  Sort Descending
                                </MenuItem>
                                {header.column.getIsSorted() && (
                                  <MenuItem value="clear" onClick={() => header.column.clearSorting()}>
                                    Clear Sort
                                  </MenuItem>
                                )}
                              </MenuContent>
                            </MenuRoot>
                          )}
                        </HStack>
                        {renderColumnFilter(header.column)}
                      </>
                    )}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>{rows}</Table.Body>
        </Table.Root>
      </Box>
      <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
        <HStack gap={2}>
          <Button size="sm" onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
            {"<<"}
          </Button>
          <Button size="sm" onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
            {"<"}
          </Button>
          <Button size="sm" onClick={() => nextPage()} disabled={!getCanNextPage()}>
            {">"}
          </Button>
          <Button size="sm" onClick={() => setPageIndex(pageCount - 1)} disabled={!getCanNextPage()}>
            {">>"}
          </Button>
        </HStack>
        <HStack gap={2} alignItems="center">
          <Text whiteSpace="nowrap">
            Page{" "}
            <strong>
              {state.pagination.pageIndex + 1} of {pageCount}
            </strong>
          </Text>
          <Text whiteSpace="nowrap">| Go to page:</Text>
          <Input
            type="number"
            defaultValue={state.pagination.pageIndex + 1}
            min={1}
            max={pageCount || 1}
            onChange={(e) => {
              const page = e.target.value ? Number(e.target.value) - 1 : 0;
              const newPageIndex = Math.max(0, Math.min(page, pageCount > 0 ? pageCount - 1 : 0));
              setPageIndex(newPageIndex);
            }}
            width="60px"
          />
        </HStack>
      </HStack>
    </VStack>
  );
}
