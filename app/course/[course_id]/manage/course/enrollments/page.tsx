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
import { FaLink, FaEdit, FaUserCog } from "react-icons/fa";
import { toaster, Toaster } from "@/components/ui/toaster";
import EditStudentProfileModal from "./editStudentProfileModal";
import EditUserRoleModal from "./editUserRoleModal";
import useAuthState from "@/hooks/useAuthState";
import { Tooltip } from "@/components/ui/tooltip";

function EnrollmentsTable() {
  const { course_id } = useParams();
  const { user: currentUser } = useAuthState();
  const [pageCount, setPageCount] = useState(0);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingStudentId, setEditingStudentId] = useState<string | undefined>(undefined);
  const [isEditUserRoleModalOpen, setIsEditUserRoleModalOpen] = useState(false);
  const [editingUserRoleData, setEditingUserRoleData] = useState<
    | {
        userRoleId: string;
        currentRole: UserRoleWithPrivateProfileAndUser["role"];
        userName: string | null | undefined;
      }
    | undefined
  >(undefined);

  const handleOpenEditModal = (studentId: string) => {
    setEditingStudentId(studentId);
    setIsEditModalOpen(true);
  };

  const handleCloseEditModal = () => {
    setIsEditModalOpen(false);
    setEditingStudentId(undefined);
  };

  const handleOpenEditUserRoleModal = (data: {
    userRoleId: string;
    currentRole: UserRoleWithPrivateProfileAndUser["role"];
    userName: string | null | undefined;
  }) => {
    setEditingUserRoleData(data);
    setIsEditUserRoleModalOpen(true);
  };

  const handleCloseEditUserRoleModal = () => {
    setIsEditUserRoleModalOpen(false);
    setEditingUserRoleData(undefined);
  };

  const onModalOpenChange = (details: { open: boolean }) => {
    if (!details.open) {
      handleCloseEditModal();
    }
  };

  const onUserRoleModalOpenChange = (details: { open: boolean }) => {
    if (!details.open) {
      handleCloseEditUserRoleModal();
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
          if (profile && profile.name) {
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
          const userRoleEntry = row.original;
          const isCurrentUserRow = currentUser?.id === userRoleEntry.user_id;

          const isTargetInstructor = userRoleEntry.role === "instructor";
          const canEditThisUserRole = !isCurrentUserRow && !isTargetInstructor;

          let tooltipContent = "Edit user role";
          if (isCurrentUserRow) {
            tooltipContent = "You cannot edit your own role";
          } else if (isTargetInstructor) {
            tooltipContent = "Instructors' roles cannot be changed";
          }

          return (
            <HStack gap={2} justifyContent="center">
              {profile && studentProfileId && (
                <Icon
                  as={FaEdit}
                  aria-label="Edit student profile"
                  cursor="pointer"
                  onClick={() => handleOpenEditModal(studentProfileId)}
                />
              )}
              {userRoleEntry && userRoleEntry.id && userRoleEntry.role && (
                <Tooltip content={tooltipContent}>
                  <Icon
                    as={FaUserCog}
                    aria-label={tooltipContent}
                    cursor={canEditThisUserRole ? "pointer" : "not-allowed"}
                    opacity={canEditThisUserRole ? 1 : 0.5}
                    onClick={() => {
                      if (canEditThisUserRole) {
                        handleOpenEditUserRoleModal({
                          userRoleId: String(userRoleEntry.id),
                          currentRole: userRoleEntry.role,
                          userName: profile?.name
                        });
                      }
                    }}
                  />
                </Tooltip>
              )}
            </HStack>
          );
        }
      }
    ],
    [currentUser]
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
            {getRowModel().rows.map((row) => (
              <Table.Row
                key={row.id}
                onClick={row.getToggleSelectedHandler()}
                cursor="pointer"
                bg={row.getIsSelected() ? "bg.subtle" : undefined}
              >
                {row
                  .getVisibleCells()
                  .filter((cell) => cell.column.id !== "class_id")
                  .map((cell) => {
                    return (
                      <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
                    );
                  })}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
          <HStack gap={2}>
            <Button onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
              {"<< First"}
            </Button>
            <Button onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
              {"< Previous"}
            </Button>
            <Button onClick={() => nextPage()} disabled={!getCanNextPage()}>
              {"Next >"}
            </Button>
            <Button onClick={() => setPageIndex(pageCount - 1)} disabled={!getCanNextPage()}>
              {"Last >>"}
            </Button>
          </HStack>

          <HStack gap={2} alignItems="center">
            <Text whiteSpace="nowrap">
              Page{" "}
              <strong>
                {getState().pagination.pageIndex + 1} of {pageCount}
              </strong>
            </Text>
            <Text whiteSpace="nowrap">| Go to page:</Text>
            <Input
              type="number"
              defaultValue={getState().pagination.pageIndex + 1}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                setPageIndex(page);
              }}
              width="100px"
              textAlign="center"
            />
          </HStack>

          <NativeSelect.Root>
            <NativeSelect.Field
              aria-label="Select page size"
              value={getState().pagination.pageSize}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                setPageSize(Number(e.target.value));
              }}
            >
              {[
                10,
                20,
                30,
                40,
                50,
                100,
                200,
                getPrePaginationRowModel().rows.length > 200 ? getPrePaginationRowModel().rows.length : undefined
              ]
                .filter((size) => typeof size === "number")
                .map((pageSize) => (
                  <option key={pageSize} value={pageSize}>
                    Show {pageSize === getPrePaginationRowModel().rows.length ? `All (${pageSize})` : pageSize}
                  </option>
                ))}
            </NativeSelect.Field>
          </NativeSelect.Root>
        </HStack>
        <Toaster />
      </VStack>
      <Box p="2" borderTop="1px solid" borderColor="border.muted" width="100%" mt={4}>
        <HStack justifyContent="flex-end">
          {" "}
          <AddSingleStudent />
        </HStack>
      </Box>
      {editingStudentId && (
        <Dialog.Root open={isEditModalOpen} onOpenChange={onModalOpenChange}>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Edit Student Profile</Dialog.Title>
                  <Dialog.CloseTrigger onClick={handleCloseEditModal} />
                </Dialog.Header>
                <Dialog.Body>
                  <EditStudentProfileModal studentProfileId={editingStudentId} onClose={handleCloseEditModal} />
                </Dialog.Body>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
      {editingUserRoleData && (
        <Dialog.Root open={isEditUserRoleModalOpen} onOpenChange={onUserRoleModalOpenChange}>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Edit User Role</Dialog.Title>
                  <Dialog.CloseTrigger onClick={handleCloseEditUserRoleModal} />
                </Dialog.Header>
                <Dialog.Body>
                  <EditUserRoleModal
                    userRoleId={editingUserRoleData.userRoleId}
                    currentRole={editingUserRoleData.currentRole}
                    userName={editingUserRoleData.userName}
                    onClose={handleCloseEditUserRoleModal}
                  />
                </Dialog.Body>
              </Dialog.Content>
            </Dialog.Positioner>
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
