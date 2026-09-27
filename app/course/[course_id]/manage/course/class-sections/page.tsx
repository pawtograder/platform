"use client";

import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { useCourseController } from "@/hooks/useCourseController";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import useModalManager from "@/hooks/useModalManager";
import {
  useIsTableControllerReady,
  useListTableControllerValues,
  useTableControllerTableValues
} from "@/lib/TableController";
import { ClassSection, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import {
  Alert,
  Box,
  Container,
  Dialog,
  Field,
  Heading,
  HStack,
  Input,
  Portal,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { FaEdit } from "react-icons/fa";

interface RenameClassSectionData {
  name: string;
}

/** Keep in step with the bound enforced by the update_class_section_name RPC. */
const MAX_SECTION_NAME_LENGTH = 100;

/** Maps TanStack's sort state onto the `aria-sort` values screen readers announce. */
function ariaSortFor(sorted: false | "asc" | "desc"): "ascending" | "descending" | undefined {
  if (sorted === "asc") {
    return "ascending";
  }
  if (sorted === "desc") {
    return "descending";
  }
  return undefined;
}

function RenameClassSectionModal({
  isOpen,
  onClose,
  onSuccess,
  section
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  section: ClassSection | undefined;
}) {
  const supabase = createClient();
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors }
  } = useForm<RenameClassSectionData>();

  useEffect(() => {
    reset({ name: section?.name ?? "" });
  }, [section, isOpen, reset]);

  const onSubmit = useCallback(
    async (data: RenameClassSectionData) => {
      if (!section) {
        return;
      }

      // Opening the dialog and saving without editing is a no-op. Skip the round
      // trip entirely; the RPC also refuses to write an identical name, so neither
      // path bumps updated_at or fires a realtime broadcast for nothing.
      const name = data.name.trim();
      if (name === section.name) {
        onClose();
        return;
      }

      setIsLoading(true);
      try {
        const { error } = await supabase.rpc("update_class_section_name", {
          p_class_section_id: section.id,
          p_name: name
        });

        if (error) {
          throw new Error(error.message);
        }

        toaster.success({ title: "Class section renamed" });
        onSuccess();
        onClose();
      } catch (error) {
        toaster.error({
          title: "Error renaming class section",
          description: error instanceof Error ? error.message : "An unknown error occurred"
        });
      } finally {
        setIsLoading(false);
      }
    },
    [section, supabase, onSuccess, onClose]
  );

  return (
    <Portal>
      <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && onClose()}>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Rename Class Section</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <form onSubmit={handleSubmit(onSubmit)}>
                <VStack gap={4} align="stretch">
                  <Field.Root invalid={!!errors.name}>
                    <Field.Label>Name</Field.Label>
                    <Input
                      placeholder="e.g., 3500 - MWF 9:15am-10:20am (Doe)"
                      {...register("name", {
                        required: "Name is required",
                        validate: (value) => {
                          const trimmed = value.trim();
                          if (trimmed.length === 0) {
                            return "Name is required";
                          }
                          // Mirrors the bound in update_class_section_name, so the
                          // limit surfaces as a field error instead of an RPC failure.
                          return trimmed.length <= MAX_SECTION_NAME_LENGTH
                            ? true
                            : `Name must be ${MAX_SECTION_NAME_LENGTH} characters or fewer`;
                        }
                      })}
                    />
                    <Field.HelperText>
                      Students see this name wherever they are asked to pick or are shown their section.
                    </Field.HelperText>
                    <Field.ErrorText>{errors.name?.message}</Field.ErrorText>
                  </Field.Root>

                  {section?.sis_crn && (
                    <Text fontSize="sm" color="fg.muted">
                      CRN {section.sis_crn}
                      {section.meeting_times ? ` · ${section.meeting_times}` : ""}
                      {section.meeting_location ? ` · ${section.meeting_location}` : ""}
                    </Text>
                  )}

                  <HStack justify="flex-end" gap={2}>
                    <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={isLoading}>
                      Save
                    </Button>
                  </HStack>
                </VStack>
              </form>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </Portal>
  );
}

type ClassSectionRow = ClassSection & {
  studentCount: number;
};

function ClassSectionsTable() {
  const controller = useCourseController();
  const isInstructor = useIsInstructor();
  const sectionsReady = useIsTableControllerReady(controller.classSections);

  const {
    isOpen: isRenameModalOpen,
    modalData: editingClassSection,
    openModal: openRenameModal,
    closeModal: closeRenameModal
  } = useModalManager<ClassSection | undefined>();

  const unsortedClassSections = useTableControllerTableValues(controller.classSections);
  const classSections = useMemo(
    () => [...unsortedClassSections].sort((a, b) => a.name.localeCompare(b.name)),
    [unsortedClassSections]
  );

  const activeStudentPredicate = useCallback(
    (role: UserRoleWithPrivateProfileAndUser) => role.role === "student" && !role.disabled,
    []
  );
  const activeStudentRoles = useListTableControllerValues(controller.userRolesWithProfiles, activeStudentPredicate);

  const studentCountByClassSection = useMemo(() => {
    const countMap = new Map<number, number>();
    activeStudentRoles.forEach((role) => {
      if (role.class_section_id) {
        countMap.set(role.class_section_id, (countMap.get(role.class_section_id) || 0) + 1);
      }
    });
    return countMap;
  }, [activeStudentRoles]);

  const tableData = useMemo<ClassSectionRow[]>(
    () =>
      classSections.map((section) => ({
        ...section,
        studentCount: studentCountByClassSection.get(section.id) || 0
      })),
    [classSections, studentCountByClassSection]
  );

  // The rename goes through the update_class_section_name RPC rather than the
  // TableController, so there is no optimistic local write to rely on. The
  // broadcast trigger on class_sections normally lands the change first, but
  // refetch so the row is correct even if the realtime channel is asleep.
  const handleRenamed = useCallback(async () => {
    await controller.classSections.refetchAll();
  }, [controller]);

  const columns = useMemo<ColumnDef<ClassSectionRow>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        accessorKey: "name",
        cell: ({ row }) => <Text fontWeight="medium">{row.original.name}</Text>
      },
      {
        id: "sis_crn",
        header: "CRN",
        accessorKey: "sis_crn",
        cell: ({ row }) => <Text>{row.original.sis_crn ?? "—"}</Text>
      },
      {
        id: "meeting_times",
        header: "Meeting Times",
        accessorKey: "meeting_times",
        cell: ({ row }) => <Text>{row.original.meeting_times || "—"}</Text>
      },
      {
        id: "meeting_location",
        header: "Location",
        accessorKey: "meeting_location",
        cell: ({ row }) => <Text>{row.original.meeting_location || "—"}</Text>
      },
      {
        id: "campus",
        header: "Campus",
        accessorKey: "campus",
        cell: ({ row }) => <Text>{row.original.campus || "—"}</Text>
      },
      {
        id: "students",
        header: "Students",
        accessorKey: "studentCount",
        enableColumnFilter: false,
        cell: ({ row }) => <Text>{row.original.studentCount}</Text>
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        enableColumnFilter: false,
        cell: ({ row }) => (
          // The Box is the tooltip trigger, not the Button: a disabled button emits no
          // pointer events, so a tooltip attached to it would never reach a grader --
          // who is exactly the person needing to be told why it is disabled.
          <Tooltip content={isInstructor ? "Rename class section" : "Only instructors can rename class sections"}>
            <Box display="inline-block">
              <Button
                size="sm"
                variant="ghost"
                disabled={!isInstructor}
                aria-label={`Rename ${row.original.name}`}
                onClick={() => openRenameModal(row.original)}
              >
                <FaEdit />
              </Button>
            </Box>
          </Tooltip>
        )
      }
    ],
    [isInstructor, openRenameModal]
  );

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  if (!sectionsReady) {
    return (
      <VStack gap={4} mt={8}>
        <Spinner />
        <Text>Loading class sections...</Text>
      </VStack>
    );
  }

  return (
    <>
      <VStack gap={4} mt={4} align="start" width="100%">
        <Heading size="lg">Class Sections</Heading>

        <Alert.Root status="info">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              Class sections are created when the roster is imported, and their meeting times, location and campus are
              refreshed from SIS every hour. Names are not: rename a section here and the name sticks.
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>

        {classSections.length === 0 ? (
          <Box p={8} textAlign="center" border="1px dashed" borderColor="border.muted" borderRadius="md" width="100%">
            <Text color="fg.muted">
              This course has no class sections. They are created by a SIS or LMS roster import.
            </Text>
          </Box>
        ) : (
          <Box width="100%" overflowX="auto">
            <Table.Root>
              <Table.Header>
                {table.getHeaderGroups().map((headerGroup) => (
                  <Table.Row bg="bg.subtle" key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      // scope="col" is load-bearing: Chakra's ColumnHeader emits a bare
                      // <th>, which Chromium then exposes as a generic `cell` rather than
                      // a `columnheader`, so the header is not associated with its column
                      // and the aria-sort below would be ignored.
                      <Table.ColumnHeader
                        key={header.id}
                        scope="col"
                        aria-sort={ariaSortFor(header.column.getIsSorted())}
                      >
                        {header.isPlaceholder ? null : (
                          <>
                            {/* A sortable header has to be a real button: the sibling
                                lab-sections page hangs onClick off a Text, which no
                                keyboard user can reach (WCAG 2.1.1). Columns that
                                cannot sort stay plain text rather than becoming a
                                button that does nothing. */}
                            {header.column.getCanSort() ? (
                              <Button
                                type="button"
                                variant="plain"
                                size="sm"
                                height="auto"
                                fontWeight="inherit"
                                userSelect="none"
                                onClick={header.column.getToggleSortingHandler()}
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {{
                                  asc: " 🔼",
                                  desc: " 🔽"
                                }[header.column.getIsSorted() as string] ?? " 🔄"}
                              </Button>
                            ) : (
                              <Text userSelect="none">
                                {flexRender(header.column.columnDef.header, header.getContext())}
                              </Text>
                            )}
                            {header.id === "name" && (
                              <Input
                                placeholder="Filter by name..."
                                size="sm"
                                value={(header.column.getFilterValue() as string) ?? ""}
                                onChange={(e) => header.column.setFilterValue(e.target.value)}
                              />
                            )}
                          </>
                        )}
                      </Table.ColumnHeader>
                    ))}
                  </Table.Row>
                ))}
              </Table.Header>
              <Table.Body>
                {table.getRowModel().rows.map((row) => (
                  <Table.Row key={row.id} id={`class-section-row-${row.original.id}`}>
                    {row.getVisibleCells().map((cell) => (
                      <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
                    ))}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
      </VStack>

      <RenameClassSectionModal
        isOpen={isRenameModalOpen}
        onClose={closeRenameModal}
        onSuccess={handleRenamed}
        section={editingClassSection}
      />
    </>
  );
}

export default function ClassSectionsPage() {
  return (
    <Container maxW="6xl">
      <ClassSectionsTable />
    </Container>
  );
}
