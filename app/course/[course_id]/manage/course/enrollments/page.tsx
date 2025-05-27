"use client";
import type { ClassSection, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
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
import { type ColumnDef, flexRender } from "@tanstack/react-table";
import { useParams } from "next/navigation";
import { useMemo, useState, useEffect, useCallback } from "react";
import AddSingleStudent from "./addSingleStudent";
import { useInvalidate, useList, useDelete } from "@refinedev/core";
import Link from "next/link";
import { enrollmentSyncCanvas } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { FaLink, FaEdit, FaUserCog, FaTrash, FaFileImport } from "react-icons/fa";
import { toaster, Toaster } from "@/components/ui/toaster";
import EditUserProfileModal from "./editUserProfileModal";
import EditUserRoleModal from "./editUserRoleModal";
import RemoveStudentModal from "./removeStudentModal";
import useAuthState from "@/hooks/useAuthState";
import useModalManager from "@/hooks/useModalManager";
import { Tooltip } from "@/components/ui/tooltip";
import ImportStudentsCSVModal from "./importStudentsCSVModal";
import { Button } from "@/components/ui/button";

type EditProfileModalData = string; // userId
type EditUserRoleModalData = {
  userRoleId: string;
  currentRole: UserRoleWithPrivateProfileAndUser["role"];
  userName: string | null | undefined;
};
type RemoveStudentModalData = {
  userRoleId: string;
  userName: string | null | undefined;
  role: UserRoleWithPrivateProfileAndUser["role"];
};

function EnrollmentsTable() {
  const { course_id } = useParams();
  const { user: currentUser } = useAuthState();
  const invalidate = useInvalidate();
  const { mutate: deleteUserRole, isLoading: isDeletingUserRole } = useDelete();

  const {
    isOpen: isEditProfileModalOpen,
    modalData: editingUserId,
    openModal: openEditProfileModal,
    closeModal: closeEditProfileModal
  } = useModalManager<EditProfileModalData>();

  const {
    isOpen: isEditUserRoleModalOpen,
    modalData: editingUserRoleData,
    openModal: openEditUserRoleModal,
    closeModal: closeEditUserRoleModal
  } = useModalManager<EditUserRoleModalData>();

  const {
    isOpen: isRemoveStudentModalOpen,
    modalData: removingStudentData,
    openModal: openRemoveStudentModal,
    closeModal: closeRemoveStudentModal
  } = useModalManager<RemoveStudentModalData>();

  const {
    isOpen: isImportCSVModalOpen,
    openModal: openImportCSVModal,
    closeModal: closeImportCSVModal
  } = useModalManager<undefined>();

  const [pageCount, setPageCount] = useState(0);

  const handleConfirmRemoveStudent = useCallback(
    (userRoleIdToRemove: string) => {
      deleteUserRole(
        {
          resource: "user_roles",
          id: userRoleIdToRemove
        },
        {
          onSuccess: () => {
            toaster.create({
              title: "User Removed",
              description: `${removingStudentData?.userName || "User"} has been removed from the course.`,
              type: "success"
            });
            invalidate({ resource: "user_roles", invalidates: ["list"] });
            closeRemoveStudentModal();
          },
          onError: (error) => {
            toaster.create({
              title: "Error Removing User",
              description: `Failed to remove user: ${error.message}`,
              type: "error"
            });
            closeRemoveStudentModal();
          }
        }
      );
    },
    [deleteUserRole, invalidate, removingStudentData?.userName, closeRemoveStudentModal]
  );

  const columns = useMemo<ColumnDef<UserRoleWithPrivateProfileAndUser>[]>(
    () => [
      {
        id: "class_id",
        accessorKey: "class_id",
        header: "Class ID",
        enableColumnFilter: true,
        enableHiding: true,
        filterFn: (row, filterValue) => {
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
        filterFn: (row, filterValue) => {
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
        filterFn: (row, filterValue) => {
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
        filterFn: (row, filterValue) => {
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
        filterFn: (row, filterValue) => {
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
          let editRoleTooltipContent = "Edit user role";
          if (isCurrentUserRow) {
            editRoleTooltipContent = "You cannot edit your own role";
          } else if (isTargetInstructor) {
            editRoleTooltipContent = "Instructors' roles cannot be changed";
          }

          const canRemoveThisUser = !isCurrentUserRow && !isTargetInstructor;
          let removeUserTooltipContent = "Remove user from course";
          if (isCurrentUserRow) {
            removeUserTooltipContent = "You cannot remove yourself";
          } else if (isTargetInstructor) {
            removeUserTooltipContent = "Instructors cannot be removed this way";
          }

          return (
            <HStack gap={2} justifyContent="center">
              {profile && studentProfileId && (
                <Tooltip content="Edit student profile">
                  <Icon
                    as={FaEdit}
                    aria-label="Edit student profile"
                    cursor="pointer"
                    onClick={() => openEditProfileModal(studentProfileId)}
                  />
                </Tooltip>
              )}
              {userRoleEntry && userRoleEntry.id && userRoleEntry.role && (
                <Tooltip content={editRoleTooltipContent}>
                  <Icon
                    as={FaUserCog}
                    aria-label={editRoleTooltipContent}
                    cursor={canEditThisUserRole ? "pointer" : "not-allowed"}
                    opacity={canEditThisUserRole ? 1 : 0.5}
                    onClick={() => {
                      if (canEditThisUserRole) {
                        openEditUserRoleModal({
                          userRoleId: String(userRoleEntry.id),
                          currentRole: userRoleEntry.role,
                          userName: profile?.name
                        });
                      }
                    }}
                  />
                </Tooltip>
              )}
              {userRoleEntry && userRoleEntry.id && (
                <Tooltip content={removeUserTooltipContent}>
                  <Icon
                    as={FaTrash}
                    aria-label={removeUserTooltipContent}
                    cursor={canRemoveThisUser ? "pointer" : "not-allowed"}
                    opacity={canRemoveThisUser ? 1 : 0.5}
                    color={canRemoveThisUser ? "red.500" : undefined}
                    onClick={() => {
                      if (canRemoveThisUser) {
                        openRemoveStudentModal({
                          userRoleId: String(userRoleEntry.id),
                          userName: profile?.name,
                          role: userRoleEntry.role
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
    [currentUser, openEditProfileModal, openEditUserRoleModal, openRemoveStudentModal]
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
                {getState().pagination.pageIndex + 1} of {pageCount}
              </strong>
            </Text>
            <Text whiteSpace="nowrap">| Go to page:</Text>
            <Input
              type="number"
              defaultValue={getState().pagination.pageIndex + 1}
              min={1}
              max={pageCount}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                const newPageIndex = Math.max(0, Math.min(page, pageCount - 1));
                setPageIndex(newPageIndex);
              }}
              width="60px"
              textAlign="center"
            />
          </HStack>

          <NativeSelect.Root title="Select page size" aria-label="Select page size" width="120px">
            <NativeSelect.Field
              title="Select page size"
              aria-label="Select page size"
              value={getState().pagination.pageSize}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                setPageSize(Number(e.target.value));
              }}
            >
              {[25, 50, 100, 200, 500].map((pageSizeOption) => (
                <option key={pageSizeOption} value={pageSizeOption}>
                  Show {pageSizeOption}
                </option>
              ))}
              {/* Add option to show all if current count is not in the default list and is greater than largest default option */}
              {![25, 50, 100, 200, 500].includes(getPrePaginationRowModel().rows.length) &&
                getPrePaginationRowModel().rows.length > 500 && (
                  <option key="all" value={getPrePaginationRowModel().rows.length}>
                    Show All ({getPrePaginationRowModel().rows.length})
                  </option>
                )}
            </NativeSelect.Field>
          </NativeSelect.Root>
        </HStack>
        <Toaster />
      </VStack>
      <Box p="2" borderTop="1px solid" borderColor="border.muted" width="100%" mt={4}>
        <HStack justifyContent="flex-end">
          {" "}
          <Button onClick={() => openImportCSVModal()}>
            <Icon as={FaFileImport} mr="2" />
            Import from CSV
          </Button>
          <AddSingleStudent />
        </HStack>
      </Box>
      {editingUserId && (
        <Dialog.Root open={isEditProfileModalOpen} onOpenChange={(details) => !details.open && closeEditProfileModal()}>
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Edit User Profile</Dialog.Title>
                  <Dialog.CloseTrigger onClick={closeEditProfileModal} />
                </Dialog.Header>
                <Dialog.Body>
                  <EditUserProfileModal userId={editingUserId} onClose={closeEditProfileModal} />
                </Dialog.Body>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
      {editingUserRoleData && (
        <Dialog.Root
          open={isEditUserRoleModalOpen}
          onOpenChange={(details) => !details.open && closeEditUserRoleModal()}
        >
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Edit User Role</Dialog.Title>
                  <Dialog.CloseTrigger onClick={closeEditUserRoleModal} />
                </Dialog.Header>
                <Dialog.Body>
                  <EditUserRoleModal
                    userRoleId={editingUserRoleData.userRoleId}
                    currentRole={editingUserRoleData.currentRole}
                    userName={editingUserRoleData.userName}
                    onClose={closeEditUserRoleModal}
                  />
                </Dialog.Body>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
      {removingStudentData && (
        <RemoveStudentModal
          isOpen={isRemoveStudentModalOpen}
          onClose={closeRemoveStudentModal}
          studentName={removingStudentData.userName}
          userRoleId={removingStudentData.userRoleId}
          onConfirmRemove={handleConfirmRemoveStudent}
          isLoading={isDeletingUserRole}
        />
      )}
      {isImportCSVModalOpen && <ImportStudentsCSVModal isOpen={isImportCSVModalOpen} onClose={closeImportCSVModal} />}
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
