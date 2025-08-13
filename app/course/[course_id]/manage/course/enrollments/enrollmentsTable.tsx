"use client";

import { Button } from "@/components/ui/button";
import InlineAddTag, { TagAddForm } from "@/components/ui/inline-add-tag";
import InlineRemoveTag from "@/components/ui/inline-remove-tag";
import PersonTags from "@/components/ui/person-tags";
import { toaster, Toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import useAuthState from "@/hooks/useAuthState";
import useModalManager from "@/hooks/useModalManager";
import useTags from "@/hooks/useTags";
import { useUserRolesWithProfiles } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { Tag, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Checkbox,
  Dialog,
  Fieldset,
  Flex,
  HStack,
  Icon,
  Input,
  NativeSelect,
  NativeSelectField,
  Portal,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import {
  ColumnDef,
  flexRender,
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { CheckIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaEdit, FaFileImport, FaLink, FaTrash, FaUserCog } from "react-icons/fa";
import { PiArrowBendLeftUpBold } from "react-icons/pi";
import AddSingleCourseMember from "./addSingleCourseMember";
import EditUserProfileModal from "./editUserProfileModal";
import EditUserRoleModal from "./editUserRoleModal";
import ImportStudentsCSVModal from "./importStudentsCSVModal";
import RemoveStudentModal from "./removeStudentModal";

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

/**
 * Client component rendering the enrollments management table for a course.
 * Provides filtering, pagination, bulk tag add/remove, and per-user actions
 * including editing profile, editing role, and removing users from the course.
 */
export default function EnrollmentsTable() {
  const { course_id } = useParams();
  const { user: currentUser } = useAuthState();
  const supabase = createClient();

  const deleteUserRole = useCallback(
    async (userRoleId: string) => {
      const { error } = await supabase.from("user_roles").delete().eq("id", parseInt(userRoleId));
      if (error) throw error;
    },
    [supabase]
  );

  const [isDeletingUserRole, setIsDeletingUserRole] = useState(false);
  const [checkedBoxes, setCheckedBoxes] = useState<Set<UserRoleWithPrivateProfileAndUser>>(
    new Set<UserRoleWithPrivateProfileAndUser>()
  );

  const { tags: tagData } = useTags();

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
    async (userRoleIdToRemove: string) => {
      setIsDeletingUserRole(true);
      try {
        await deleteUserRole(userRoleIdToRemove);
        toaster.create({
          title: "User Removed",
          description: `${removingStudentData?.userName || "User"} has been removed from the course.`,
          type: "success"
        });
        closeRemoveStudentModal();
      } catch (error) {
        toaster.create({
          title: "Error Removing User",
          description: `Failed to remove user: ${error instanceof Error ? error.message : "Unknown error"}`,
          type: "error"
        });
        closeRemoveStudentModal();
      } finally {
        setIsDeletingUserRole(false);
      }
    },
    [deleteUserRole, removingStudentData?.userName, closeRemoveStudentModal]
  );

  const checkedBoxesRef = useRef(new Set<UserRoleWithPrivateProfileAndUser>());

  const handleSingleCheckboxChange = useCallback((user: UserRoleWithPrivateProfileAndUser, checked: boolean) => {
    if (checked === true) {
      checkedBoxesRef.current.add(user);
    } else {
      checkedBoxesRef.current.delete(user);
    }
    setCheckedBoxes(new Set(checkedBoxesRef.current));
  }, []);

  const checkboxClear = () => {
    checkedBoxesRef.current.clear();
    setCheckedBoxes(new Set(checkedBoxesRef.current));
  };

  const addTag = async (values: Omit<Tag, "id" | "created_at">) => {
    const { error } = await supabase.from("tags").insert(values);
    if (error) throw error;
  };

  useEffect(() => {
    if (checkedBoxes.size === 0) {
      setStrategy("none");
    }
  }, [checkedBoxes]);

  const columns = useMemo<ColumnDef<UserRoleWithPrivateProfileAndUser>[]>(
    () => [
      {
        id: "checkbox",
        header: "",
        cell: ({ row }) => {
          return (
            <Checkbox.Root
              checked={
                Array.from(checkedBoxesRef.current).find((box) => {
                  return box.private_profile_id === row.original.private_profile_id;
                }) != undefined
              }
              onCheckedChange={(checked) => handleSingleCheckboxChange(row.original, checked.checked.valueOf() == true)}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control>
                <CheckIcon></CheckIcon>
              </Checkbox.Control>
            </Checkbox.Root>
          );
        }
      },
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
        id: "tags",
        header: "Tags",
        accessorKey: "tags",
        filterFn: (row, id, filterValue) => {
          const profileTagNames = tagData
            .filter((tag) => {
              return (
                tag.profile_id === row.original.private_profile_id || tag.profile_id === row.original.public_profile_id
              );
            })
            .map((tag) => {
              return tag.name;
            });
          return profileTagNames.includes(filterValue);
        },
        cell: ({ row }) => {
          return (
            <Flex flexDirection={"row"} width="100%" gap="5px" wrap="wrap">
              <PersonTags profile_id={row.original.private_profile_id} showRemove />
              <InlineAddTag profile_id={row.original.private_profile_id} allowExpand={false} />
            </Flex>
          );
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
    [
      currentUser,
      openEditProfileModal,
      openEditUserRoleModal,
      openRemoveStudentModal,
      tagData,
      handleSingleCheckboxChange
    ]
  );

  // Get user roles data from CourseController (realtime)
  const userRolesData = useUserRolesWithProfiles();

  // Create local table using react-table
  const table = useReactTable({
    data: userRolesData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 50
      }
    }
  });

  const getHeaderGroups = table.getHeaderGroups;
  const getRowModel = table.getRowModel;
  const getRowCount = () => table.getFilteredRowModel().rows.length;
  const getState = table.getState;
  const setPageIndex = table.setPageIndex;
  const getCanPreviousPage = table.getCanPreviousPage;
  const getCanNextPage = table.getCanNextPage;
  const nextPage = table.nextPage;
  const previousPage = table.previousPage;
  const setPageSize = table.setPageSize;
  const getPrePaginationRowModel = table.getPrePaginationRowModel;

  const nRows = getRowCount();
  const pageSize = getState().pagination.pageSize;
  useEffect(() => {
    setPageCount(Math.ceil(nRows / pageSize));
  }, [nRows, pageSize]);
  const [strategy, setStrategy] = useState<"add" | "remove" | "none">("none");

  const deleteMutation = async (params: { resource: string; id: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from(params.resource).delete().eq("id", params.id);
    if (error) throw error;
  };

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
                              textAlign={header.id === "actions" || header.id === "checkbox" ? "center" : undefined}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {{
                                asc: " 🔼",
                                desc: " 🔽"
                              }[header.column.getIsSorted() as string] ?? null}
                            </Text>
                            {header.id === "checkbox" && (
                              <Checkbox.Root
                                checked={checkedBoxesRef.current.size === getRowModel().rows.length}
                                onCheckedChange={(checked) => {
                                  if (checked.checked.valueOf() === true) {
                                    getRowModel()
                                      .rows.map((row) => row.original)
                                      .forEach((row) => {
                                        checkedBoxesRef.current.add(row);
                                      });
                                    setCheckedBoxes(new Set(checkedBoxesRef.current));
                                  } else {
                                    checkboxClear();
                                  }
                                }}
                              >
                                <Checkbox.HiddenInput />
                                <Checkbox.Control>
                                  {" "}
                                  <CheckIcon></CheckIcon>
                                </Checkbox.Control>
                              </Checkbox.Root>
                            )}
                            {header.id !== "actions" && header.id !== "checkbox" && header.id !== "tags" && (
                              <Input
                                id={header.id}
                                value={(header.column.getFilterValue() as string) ?? ""}
                                onChange={(e) => {
                                  header.column.setFilterValue(e.target.value);
                                }}
                              />
                            )}
                            {header.id === "tags" && (
                              <Select
                                isMulti={false}
                                id={header.id}
                                onChange={(e) => {
                                  if (e) {
                                    header.column.setFilterValue(e.value?.name);
                                    checkboxClear();
                                  }
                                }}
                                options={[
                                  ...Array.from(
                                    tagData
                                      .reduce((map, p) => {
                                        if (!map.has(p.name)) {
                                          map.set(p.name, p);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((p) => ({ label: p.name, value: p })),
                                  { label: "<none>", value: null }
                                ]}
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
        <Flex marginLeft="15px" flexDir={"row"} alignItems={"center"} fontSize="var(--chakra-font-sizes-sm)">
          <PiArrowBendLeftUpBold width={"30px"} height={"30px"} />
          Select people
          <Button
            height="fit-content"
            padding="0"
            width="fit-content"
            variant={"ghost"}
            colorPalette={"blue"}
            onClick={() => {
              getRowModel()
                .rows.map((row) => row.original)
                .forEach((row) => {
                  checkedBoxesRef.current.add(row);
                });
              setCheckedBoxes(new Set(checkedBoxesRef.current));
            }}
          >
            (or select all {getRowModel().rows.length})
          </Button>
          , then
          <Flex>
            <Fieldset.Root size="sm" ml="2">
              <Fieldset.Content display="flex" flexDir={"row"} alignItems={"center"}>
                <NativeSelect.Root disabled={checkedBoxes.size < 1}>
                  <NativeSelectField
                    value={strategy}
                    onChange={(e) => {
                      setStrategy(e.target.value as "add" | "remove" | "none");
                    }}
                  >
                    <option value="none">{"<Select>"}</option>
                    <option value="add">Add tag</option>
                    <option value="remove">Remove tag</option>
                  </NativeSelectField>
                </NativeSelect.Root>
                {strategy === "add" && (
                  <TagAddForm
                    addTag={async (name: string, color?: string) => {
                      try {
                        await Promise.all(
                          Array.from(checkedBoxes).map((profile) =>
                            addTag({
                              name: name.startsWith("~") ? name.slice(1) : name,
                              color: color || "gray",
                              visible: !name.startsWith("~"),
                              profile_id: profile.private_profile_id,
                              class_id: parseInt(course_id as string),
                              creator_id: currentUser?.id || ""
                            })
                          )
                        );
                        setStrategy("none");
                      } catch (error) {
                        toaster.error({
                          title: "Error adding tag(s)",
                          description: error instanceof Error ? error.message : "Unknown error"
                        });
                      }
                    }}
                    currentTags={tagData.filter((tag) => {
                      return Array.from(checkedBoxes)
                        .map((row) => row.private_profile_id)
                        .includes(tag.profile_id);
                    })}
                    allowExpand={true}
                  />
                )}
                {strategy === "remove" && (
                  <InlineRemoveTag
                    tagOptions={
                      checkedBoxes.size === 0
                        ? []
                        : Array.from(
                            tagData
                              .reduce((map, tag) => {
                                const key = JSON.stringify({ name: tag.name, color: tag.color, visible: tag.visible });
                                if (!map.has(key)) {
                                  map.set(key, tag);
                                }
                                return map;
                              }, new Map())
                              .values()
                          ).filter((tag) => {
                            const checkedProfileIds = Array.from(checkedBoxes).map((box) => box.private_profile_id);

                            return checkedProfileIds.every((profileId) =>
                              tagData.some(
                                (t) =>
                                  t.profile_id === profileId &&
                                  t.name === tag.name &&
                                  t.color === tag.color &&
                                  t.visible === tag.visible
                              )
                            );
                          })
                    }
                    removeTag={(tagName: string, tagColor: string, tagVisibility: boolean) => {
                      Promise.all(
                        Array.from(checkedBoxes).map(async (profile) => {
                          const findTag = tagData.find((tag) => {
                            return (
                              tag.name === tagName &&
                              tag.color === tagColor &&
                              tagVisibility === tag.visible &&
                              tag.profile_id === profile.private_profile_id
                            );
                          });
                          if (!findTag) {
                            toaster.error({
                              title: "Error removing tag",
                              description: "Tag not found on profile " + (profile.profiles?.name || "Unknown")
                            });
                            return;
                          }
                          return deleteMutation({
                            resource: "tags",
                            id: findTag.id
                          });
                        })
                      )
                        .then(() => {
                          setStrategy("none");
                        })
                        .catch((error: unknown) => {
                          toaster.error({
                            title: "Error removing tags",
                            description: error instanceof Error ? error.message : "Unknown error"
                          });
                        });
                    }}
                  />
                )}
              </Fieldset.Content>
            </Fieldset.Root>
          </Flex>
        </Flex>

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
          <AddSingleCourseMember />
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
