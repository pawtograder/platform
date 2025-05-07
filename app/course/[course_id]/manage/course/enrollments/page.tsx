"use client";
import { ClassSection, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  Container,
  Heading,
  HStack,
  Icon,
  Input,
  List,
  NativeSelect,
  Table,
  Text,
  VStack,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogHeader,
  DialogPositioner,
  DialogTitle,
  Portal
} from "@chakra-ui/react";
import { useTable } from "@refinedev/react-table";
import { ColumnDef, flexRender } from "@tanstack/react-table";

import { useParams } from "next/navigation";
import { useMemo, useState, useEffect } from "react";
import AddSingleStudent from "./addSingleStudent";
import { useInvalidate, useList } from "@refinedev/core";
import Link from "next/link";
import { enrollmentSyncCanvas } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { FaLink, FaEdit } from "react-icons/fa";
import { toaster, Toaster } from "@/components/ui/toaster";
import EditStudentProfileModal from "./editStudentProfileModal";

function EnrollmentsTable() {
  const { course_id } = useParams();
  const [pageCount, setPageCount] = useState(0);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingStudentId, setEditingStudentId] = useState<string | undefined>(undefined);

  const handleOpenEditModal = (studentId: string) => {
    setEditingStudentId(studentId);
    setIsEditModalOpen(true);
  };

  const handleCloseEditModal = () => {
    setIsEditModalOpen(false);
    setEditingStudentId(undefined);
  };

  const onModalOpenChange = (details: { open: boolean }) => {
    if (!details.open) {
      handleCloseEditModal();
    }
  };

  const columns = useMemo<ColumnDef<UserRoleWithPrivateProfileAndUser>[]>(
    () => [
      {
        id: "class_id",
        accessorKey: "class_id",
        header: "Class ID",
        enableColumnFilter: true,
        enableHiding: true,
        filterFn: (row, id, filterValue) => {
          return String(row.original.class_id) === String(filterValue);
        }
      },
      {
        id: "profiles.name",
        accessorKey: "profiles.name",
        header: "Name",
        enableColumnFilter: true,
        cell: ({ row }) => {
          const profile = row.original.profiles;
          const courseId = course_id;
          const studentProfileId = profile?.id;

          if (profile && studentProfileId && profile.name) {
            if (row.original.role === "student") {
              return (
                <Link href={`/course/${courseId}/manage/students/${studentProfileId}/edit`} passHref legacyBehavior>
                  <Text as="a" _hover={{ textDecoration: "underline" }} cursor="pointer">
                    {profile.name}
                  </Text>
                </Link>
              );
            }
            return profile.name;
          }
          return "N/A";
        },
        filterFn: (row, id, filterValue) => {
          const name = row.original.profiles?.name;
          if (!name) return false;
          const filterString = String(filterValue).toLowerCase();
          return name.toLowerCase().includes(filterString);
        }
      },
      {
        id: "users.email",
        accessorKey: "users.email",
        header: "Email",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const email = row.original.users?.email;
          if (!email) return false;
          const filterString = String(filterValue).toLowerCase();
          return email.toLowerCase().includes(filterString);
        }
      },
      {
        id: "role",
        header: "Role",
        accessorKey: "role",
        filterFn: (row, id, filterValue) => {
          const role = row.original.role;
          if (!role) return false;
          const filterString = String(filterValue).toLowerCase();
          return role.toLowerCase().includes(filterString);
        }
      },
      {
        id: "github_username",
        header: "Github Username",
        accessorKey: "users.github_username",
        filterFn: (row, id, filterValue) => {
          const username = row.original.users?.github_username;
          if (!username) return false;
          const filterString = String(filterValue).toLowerCase();
          return username.toLowerCase().includes(filterString);
        }
      },
      {
        id: "canvas_id",
        header: "Canvas Link",
        accessorKey: "canvas_id",
        cell: ({ row }) => {
          if (row.original.canvas_id) {
            return <Icon aria-label="Linked to Canvas" as={FaLink} />;
          }
          return null;
        }
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const profile = row.original.profiles;
          const studentProfileId = profile?.id;

          if (row.original.role === "student" && profile && studentProfileId) {
            return (
              <Box textAlign="center">
                <Icon
                  as={FaEdit}
                  aria-label="Edit student profile"
                  cursor="pointer"
                  onClick={() => handleOpenEditModal(studentProfileId)}
                />
              </Box>
            );
          }
          return null;
        }
      }
    ],
    [course_id]
  );
  const {
    getHeaderGroups,
    getRowModel,
    getRowCount,
    getState,
    setPageIndex,
    getCanPreviousPage,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    getPrePaginationRowModel
  } = useTable({
    columns,
    initialState: {
      columnFilters: [{ id: "class_id", value: course_id as string }],
      pagination: {
        pageIndex: 0,
        pageSize: 50
      }
    },
    refineCoreProps: {
      resource: "user_roles",
      filters: {
        mode: "off"
      },
      sorters: {
        mode: "off"
      },
      pagination: {
        mode: "off"
      },
      meta: {
        select: "*,profiles!private_profile_id(*), users(*)"
      }
    },
    manualPagination: false,
    manualFiltering: false,
    manualSorting: false,
    pageCount,
    filterFromLeafRows: true
  });

  const nRows = getRowCount();
  const pageSize = getState().pagination.pageSize;
  useEffect(() => {
    setPageCount(Math.ceil(nRows / pageSize));
  }, [nRows, pageSize]);

  return (
    <VStack align="start" w="100%">
      <VStack paddingBottom="55px" align="start" w="100%">
        <Table.Root>
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row bg="bg.subtle" key={headerGroup.id}>
                {headerGroup.headers
                  .filter((h) => h.id !== "class_id")
                  .map((header) => {
                    return (
                      <Table.ColumnHeader key={header.id}>
                        {header.isPlaceholder ? null : (
                          <>
                            <Text
                              onClick={header.column.getToggleSortingHandler()}
                              textAlign={header.id === "actions" ? "center" : undefined}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {{
                                asc: " 🔼",
                                desc: " 🔽"
                              }[header.column.getIsSorted() as string] ?? null}
                            </Text>
                            {header.id !== "actions" && (
                              <Input
                                id={header.id}
                                value={(header.column.getFilterValue() as string) ?? ""}
                                onChange={(e) => {
                                  header.column.setFilterValue(e.target.value);
                                }}
                              />
                            )}
                          </>
                        )}
                      </Table.ColumnHeader>
                    );
                  })}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {getRowModel()
              .rows //.filter(row => row.getValue("profiles.name") !== undefined)
              .map((row) => {
                return (
                  <Table.Row key={row.id}>
                    {row
                      .getVisibleCells()
                      .filter((c) => c.column.id !== "class_id")
                      .map((cell) => {
                        return (
                          <Table.Cell key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </Table.Cell>
                        );
                      })}
                  </Table.Row>
                );
              })}
          </Table.Body>
        </Table.Root>
        <HStack>
          <Button onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
            {"<<"}
          </Button>
          <Button id="previous-button" onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
            {"<"}
          </Button>
          <Button id="next-button" onClick={() => nextPage()} disabled={!getCanNextPage()}>
            {">"}
          </Button>
          <Button onClick={() => setPageIndex(pageCount - 1)} disabled={!getCanNextPage()}>
            {">>"}
          </Button>
          <VStack>
            <Text>Page</Text>
            <Text>
              {getState().pagination.pageIndex + 1} of {pageCount}
            </Text>
          </VStack>
          <VStack>
            | Go to page:
            <input
              title="Go to page"
              type="number"
              defaultValue={getState().pagination.pageIndex + 1}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                setPageIndex(page);
              }}
            />
          </VStack>
          <VStack>
            <Text id="page-size-label">Show</Text>
            <NativeSelect.Root>
              <NativeSelect.Field
                aria-labelledby="page-size-label"
                title="Select page size"
                value={"" + getState().pagination.pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                }}
              >
                {[25, 50, 100, 200, 500].map((pageSize) => (
                  <option key={pageSize} value={pageSize}>
                    Show {pageSize}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </VStack>
        </HStack>
        <div>{getPrePaginationRowModel().rows.length} Rows</div>
      </VStack>
      <Box
        p="2"
        border="1px solid"
        borderColor="border.muted"
        backgroundColor="bg.subtle"
        height="55px"
        style={{
          position: "fixed",
          bottom: 0,
          right: 0,
          width: "100%"
        }}
      >
        <HStack>
          <AddSingleStudent />
        </HStack>
      </Box>
      {editingStudentId && (
        <Dialog.Root open={isEditModalOpen} onOpenChange={onModalOpenChange} size="xl">
          <Portal>
            <DialogBackdrop />
            <DialogPositioner>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Edit Student Profile</DialogTitle>
                </DialogHeader>
                <DialogCloseTrigger />
                <DialogBody>
                  <EditStudentProfileModal studentProfileId={editingStudentId} onClose={handleCloseEditModal} />
                </DialogBody>
              </DialogContent>
            </DialogPositioner>
          </Portal>
        </Dialog.Root>
      )}
    </VStack>
  );
}
export default function EnrollmentsPage() {
  const { course_id } = useParams();
  const [isSyncing, setIsSyncing] = useState(false);
  const invalidate = useInvalidate();
  const { data: sections } = useList<ClassSection>({
    resource: "class_sections",
    filters: [{ field: "class_id", operator: "eq", value: course_id as string }]
  });
  return (
    <Container>
      <Heading my="4">Enrollments</Heading>
      <Box border="1px solid" borderColor="border.muted" borderRadius="md" p="4" mb="4">
        <Heading size="sm" mb={3}>
          Canvas Links
        </Heading>
        <Text fontSize="sm" color="fg.muted" mb={3}>
          Enrollments in this course are linked to the following Canvas sections:
        </Text>
        <List.Root as="ul" pl="4" mb={3}>
          {sections?.data?.map((section) => (
            <List.Item key={section.id} as="li" fontSize="sm">
              <Link href={`https://canvas.instructure.com/courses/${section.canvas_course_id}`}>{section.name}</Link>
            </List.Item>
          ))}
        </List.Root>
        <Toaster />
        <Button
          loading={isSyncing}
          colorPalette="green"
          size="sm"
          variant="surface"
          onClick={async () => {
            setIsSyncing(true);
            const supabase = createClient();
            try {
              await enrollmentSyncCanvas({ course_id: Number(course_id) }, supabase);
              toaster.create({
                title: "Synced Canvas Enrollments",
                description: "Canvas enrollments have been synced",
                type: "success"
              });

              invalidate({ resource: "user_roles", invalidates: ["all"] });
            } catch (error) {
              toaster.create({
                title: "Error syncing Canvas Enrollments",
                description: error instanceof Error ? error.message : "An unknown error occurred",
                type: "error"
              });
            }
            setIsSyncing(false);
          }}
        >
          Sync Canvas Enrollments
        </Button>
      </Box>
      <EnrollmentsTable />
    </Container>
  );
}
