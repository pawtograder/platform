"use client";

import { Button } from "@/components/ui/button";
import InlineAddTag, { TagAddForm } from "@/components/ui/inline-add-tag";
import InlineRemoveTag from "@/components/ui/inline-remove-tag";
import PersonTags from "@/components/ui/person-tags";
import { toaster, Toaster } from "@/components/ui/toaster";
import { Tooltip } from "@/components/ui/tooltip";
import useAuthState from "@/hooks/useAuthState";
import { useClassSections, useLabSections, useUserRolesWithProfiles } from "@/hooks/useCourseController";
import useModalManager from "@/hooks/useModalManager";
import useTags from "@/hooks/useTags";
import { createClient } from "@/utils/supabase/client";
import { Tag, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import type { Database } from "@/utils/supabase/SupabaseTypes";
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
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { CheckIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaEdit, FaLink, FaTrash, FaUserCog, FaClock, FaTimes, FaFileExport } from "react-icons/fa";
import { PiArrowBendLeftUpBold } from "react-icons/pi";
import EditUserProfileModal from "./editUserProfileModal";
import EditUserRoleModal from "./editUserRoleModal";
import RemoveStudentModal from "./removeStudentModal";
import ImportStudentsCSVModal from "./importStudentsCSVModal";
import AddSingleCourseMember from "./addSingleCourseMember";

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

// Invitation type for display
type InvitationRow = Database["public"]["Tables"]["invitations"]["Row"] & { type: "invitation" };

// Combined type for table rows
type EnrollmentTableRow = (UserRoleWithPrivateProfileAndUser & { type: "enrollment" }) | InvitationRow;

/**
 * Client component rendering the enrollments management table for a course.
 * Provides filtering, pagination, bulk tag add/remove, and per-user actions
 * including editing profile, editing role, and removing users from the course.
 */
export default function EnrollmentsTable() {
  const { course_id } = useParams();
  const { user: currentUser } = useAuthState();
  const supabase = createClient();
  const labSections = useLabSections();
  const classSections = useClassSections();

  const disableUserRole = useCallback(
    async (userRoleId: string) => {
      const { error } = await supabase.from("user_roles").update({ disabled: true }).eq("id", parseInt(userRoleId));
      if (error) throw error;
    },
    [supabase]
  );

  const [isDeletingUserRole, setIsDeletingUserRole] = useState(false);
  const [checkedBoxes, setCheckedBoxes] = useState<Set<EnrollmentTableRow>>(new Set<EnrollmentTableRow>());

  // Invitations state
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);

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

  const [pageCount, setPageCount] = useState(0);

  const handleConfirmRemoveStudent = useCallback(
    async (userRoleIdToRemove: string) => {
      setIsDeletingUserRole(true);
      try {
        await disableUserRole(userRoleIdToRemove);
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
    [disableUserRole, removingStudentData?.userName, closeRemoveStudentModal]
  );

  const checkedBoxesRef = useRef(new Set<EnrollmentTableRow>());

  const handleSingleCheckboxChange = useCallback((row: EnrollmentTableRow, checked: boolean) => {
    if (checked === true) {
      checkedBoxesRef.current.add(row);
    } else {
      checkedBoxesRef.current.delete(row);
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

  // Fetch invitations
  const fetchInvitations = useCallback(async () => {
    if (!course_id) return;

    try {
      const { data, error } = await supabase
        .from("invitations")
        .select("*")
        .eq("class_id", parseInt(course_id as string))
        .neq("status", "accepted")
        .neq("status", "expired")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const invitationRows: InvitationRow[] = (data || []).map((invitation) => ({
        ...invitation,
        type: "invitation" as const
      }));

      setInvitations(invitationRows);
    } catch (error) {
      toaster.create({
        title: "Error fetching invitations",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error"
      });
    }
  }, [course_id, supabase]);

  // Cancel invitation
  const cancelInvitation = useCallback(
    async (invitationId: number) => {
      try {
        const { error } = await supabase.from("invitations").update({ status: "cancelled" }).eq("id", invitationId);

        if (error) throw error;

        // Refresh invitations
        await fetchInvitations();

        toaster.create({
          title: "Invitation Cancelled",
          description: "The invitation has been cancelled successfully.",
          type: "success"
        });
      } catch (error) {
        toaster.create({
          title: "Error cancelling invitation",
          description: error instanceof Error ? error.message : "Unknown error",
          type: "error"
        });
      }
    },
    [supabase, fetchInvitations]
  );

  // Load invitations on mount
  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  useEffect(() => {
    if (checkedBoxes.size === 0) {
      setStrategy("none");
    }
  }, [checkedBoxes]);

  const columns = useMemo<ColumnDef<EnrollmentTableRow>[]>(
    () => [
      {
        id: "checkbox",
        header: "",
        cell: ({ row }) => {
          const isChecked =
            Array.from(checkedBoxesRef.current).find((box) => {
              if (row.original.type === "invitation") {
                return box.type === "invitation" && box.id === row.original.id;
              } else {
                return box.type === "enrollment" && box.private_profile_id === row.original.private_profile_id;
              }
            }) !== undefined;

          return (
            <Checkbox.Root
              checked={isChecked}
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
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            const invitation = row.original;
            const isExpired = invitation.expires_at && new Date(invitation.expires_at) < new Date();
            const statusColor =
              invitation.status === "pending"
                ? isExpired
                  ? "orange.500"
                  : "blue.500"
                : invitation.status === "accepted"
                  ? "green.500"
                  : "red.500";

            return (
              <Flex alignItems="center" gap={2}>
                <Icon as={FaClock} color={statusColor} />
                <Text color={statusColor} fontWeight="medium">
                  {invitation.status === "pending" && isExpired ? "Expired" : invitation.status}
                </Text>
              </Flex>
            );
          }
          if (row.original.disabled) {
            return (
              <Flex alignItems="center" gap={2}>
                <Icon as={FaTimes} color="gray.fg" />
                <Text color="gray.fg" fontWeight="medium">
                  Dropped
                </Text>
              </Flex>
            );
          }
          return (
            <Flex alignItems="center" gap={2}>
              <Icon as={CheckIcon} color="green.fg" />
              <Text color="green.fg" fontWeight="medium">
                Enrolled
              </Text>
            </Flex>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = (Array.isArray(filterValue) ? filterValue : [filterValue]).map((value) => value.toLowerCase());

          if (row.original.type === "invitation") {
            const invitation = row.original;
            const isExpired = invitation.expires_at && new Date(invitation.expires_at) < new Date();
            const status = invitation.status === "pending" && isExpired ? "Expired" : invitation.status;
            return values.includes(status.toLowerCase());
          }
          if (row.original.disabled) {
            return values.includes("dropped");
          }
          return values.includes("enrolled");
        }
      },
      {
        id: "profiles.name",
        accessorFn: (row) => {
          if (row.type === "invitation") {
            return row.name || row.sis_user_id || "N/A";
          }
          return row.profiles?.name || "N/A";
        },
        header: "Name",
        enableColumnFilter: true,
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            return row.original.name || row.original.sis_user_id || "N/A";
          }
          const profile = row.original.profiles;
          if (profile && profile.name) {
            return profile.name;
          }
          return "N/A";
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (row.original.type === "invitation") {
            const invitationName = row.original.name || `${row.original.sis_user_id}` || "";
            return values.some((val) => invitationName.toLowerCase().includes(val.toLowerCase()));
          }
          const name = row.original.profiles?.name;
          if (!name) return false;
          return values.some((val) => name.toLowerCase().includes(val.toLowerCase()));
        }
      },
      {
        id: "users.email",
        accessorFn: (row) => {
          if (row.type === "invitation") {
            return row.email || "N/A";
          }
          return row.users?.email || "N/A";
        },
        header: "Email",
        enableColumnFilter: true,
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            return row.original.email || "N/A";
          }
          return row.original.users?.email || "N/A";
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (row.original.type === "invitation") {
            const email = row.original.email;
            if (!email) return false;
            return values.some((val) => email.toLowerCase().includes(val.toLowerCase()));
          }
          const email = row.original.users?.email;
          if (!email) return false;
          return values.some((val) => email.toLowerCase().includes(val.toLowerCase()));
        }
      },
      {
        id: "role",
        header: "Role",
        accessorKey: "role",
        cell: ({ row }) => {
          return row.original.role;
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const role = row.original.role;
          if (!role) return false;
          return values.includes(role);
        }
      },
      {
        id: "class_section",
        header: "Class Section",
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            const invitation = row.original;
            if (invitation.class_section_id && classSections) {
              const classSection = classSections.find((section) => section.id === invitation.class_section_id);
              if (classSection) {
                return <Text fontSize="sm">{classSection.name || `Section ${classSection.id}`}</Text>;
              } else {
                return (
                  <Text color="gray.400" fontSize="sm">
                    {invitation.class_section_id}
                  </Text>
                );
              }
            }
            return (
              <Text color="gray.400" fontSize="sm">
                Not assigned
              </Text>
            );
          }

          const userRole = row.original;
          if (userRole.class_section_id && classSections) {
            const classSection = classSections.find((section) => section.id === userRole.class_section_id);
            if (classSection) {
              return <Text fontSize="sm">{classSection.name || `Section ${classSection.id}`}</Text>;
            }
          }
          return (
            <Text color="gray.400" fontSize="sm">
              Not assigned
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (row.original.type === "invitation") {
            const invitation = row.original;
            if (!invitation.class_section_id || !classSections) {
              return values.includes("Not assigned");
            }

            const classSection = classSections.find((section) => section.id === invitation.class_section_id);
            if (!classSection) return values.includes("Not assigned");

            const sectionName = classSection.name || `Section ${classSection.id}`;
            return values.includes(sectionName);
          }

          const userRole = row.original;
          if (!userRole.class_section_id || !classSections) {
            return values.includes("Not assigned");
          }

          const classSection = classSections.find((section) => section.id === userRole.class_section_id);
          if (!classSection) return values.includes("Not assigned");

          const sectionName = classSection.name || `Section ${classSection.id}`;
          return values.includes(sectionName);
        }
      },
      {
        id: "lab_section",
        header: "Lab Section",
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            const invitation = row.original;
            if (invitation.lab_section_id && labSections) {
              const labSection = labSections.find((section) => section.id === invitation.lab_section_id);
              if (labSection) {
                return <Text fontSize="sm">{labSection.name || `Lab ${labSection.id}`}</Text>;
              }
            }
            return (
              <Text color="gray.400" fontSize="sm">
                Not assigned
              </Text>
            );
          }

          const userRole = row.original;
          if (userRole.lab_section_id && labSections) {
            const labSection = labSections.find((section) => section.id === userRole.lab_section_id);
            if (labSection) {
              return <Text fontSize="sm">{labSection.name || `Lab ${labSection.id}`}</Text>;
            }
          }
          return (
            <Text color="gray.400" fontSize="sm">
              Not assigned
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (row.original.type === "invitation") {
            const invitation = row.original;
            if (!invitation.lab_section_id || !labSections) {
              return values.includes("Not assigned");
            }

            const labSection = labSections.find((section) => section.id === invitation.lab_section_id);
            if (!labSection) return values.includes("Not assigned");

            const sectionName = labSection.name || `Lab ${labSection.id}`;
            return values.includes(sectionName);
          }

          const userRole = row.original;
          if (!userRole.lab_section_id || !labSections) {
            return values.includes("Not assigned");
          }

          const labSection = labSections.find((section) => section.id === userRole.lab_section_id);
          if (!labSection) return values.includes("Not assigned");

          const sectionName = labSection.name || `Lab ${labSection.id}`;
          return values.includes(sectionName);
        }
      },
      {
        id: "github_username",
        header: "Github Username",
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            return "N/A";
          }
          const name = row.original.users?.github_username || "N/A";
          return name;
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (row.original.type === "invitation") {
            return values.includes("N/A");
          }
          const username = row.original.users?.github_username;
          if (!username) {
            return values.includes("N/A");
          }
          return values.includes(username);
        }
      },
      {
        id: "github_org_confirmed",
        header: "GitHub Org Status",
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            return (
              <Text color="gray.400" fontSize="sm">
                N/A
              </Text>
            );
          }
          if (row.original.github_org_confirmed) {
            return (
              <Flex alignItems="center" gap={2}>
                <Icon as={CheckIcon} color="green.600" />
                <Text color="green.600" fontWeight="medium" fontSize="sm">
                  Joined
                </Text>
              </Flex>
            );
          }
          return (
            <Flex alignItems="center" gap={2}>
              <Icon as={FaTimes} color="red.600" />
              <Text color="red.600" fontWeight="medium" fontSize="sm">
                Not joined
              </Text>
            </Flex>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (row.original.type === "invitation") {
            return values.includes("N/A");
          }

          const status = row.original.github_org_confirmed ? "Joined" : "Not joined";
          return values.includes(status);
        }
      },
      {
        id: "canvas_id",
        header: "SIS Link",
        accessorFn: (row) => {
          if (row.type === "invitation") {
            return null;
          }
          return row.canvas_id ? "Linked" : null;
        },
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            return null;
          }
          if (row.original.canvas_id) {
            return <Icon aria-label="Linked to Canvas" as={FaLink} />;
          }
          return null;
        }
      },
      {
        id: "tags",
        header: "Tags",
        accessorFn: (row) => {
          if (row.type === "invitation") {
            return "N/A (Pending)";
          }
          // Return a string representation of tags for this profile
          const profileTags = tagData
            .filter((tag) => {
              return tag.profile_id === row.private_profile_id || tag.profile_id === row.public_profile_id;
            })
            .map((tag) => tag.name);
          return profileTags.length > 0 ? profileTags.join(", ") : "No tags";
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];

          if (row.original.type === "invitation") {
            return values.includes("N/A (Pending)");
          }
          const enrollment = row.original;
          const profileTagNames = tagData
            .filter((tag) => {
              return (
                tag.profile_id === enrollment.private_profile_id || tag.profile_id === enrollment.public_profile_id
              );
            })
            .map((tag) => {
              return tag.name;
            });
          return values.some((val) => profileTagNames.includes(val));
        },
        cell: ({ row }) => {
          if (row.original.type === "invitation") {
            return (
              <Text color="gray.500" fontSize="sm">
                N/A (Pending)
              </Text>
            );
          }
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
          if (row.original.type === "invitation") {
            const invitation = row.original;
            const isPending = invitation.status === "pending";
            const isExpired = invitation.expires_at && new Date(invitation.expires_at) < new Date();
            const canCancel = isPending && !isExpired;

            return (
              <HStack gap={2} justifyContent="center">
                {canCancel && (
                  <Tooltip content="Cancel invitation">
                    <Icon
                      as={FaTimes}
                      aria-label="Cancel invitation"
                      cursor="pointer"
                      color="red.500"
                      onClick={() => cancelInvitation(invitation.id)}
                    />
                  </Tooltip>
                )}
                {!canCancel && (
                  <Text fontSize="sm" color="gray.500">
                    {isExpired ? "Expired" : invitation.status}
                  </Text>
                )}
              </HStack>
            );
          }

          // Enrolled user actions
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
      handleSingleCheckboxChange,
      cancelInvitation,
      classSections,
      labSections
    ]
  );

  // Get user roles data from CourseController (realtime)
  const userRolesData = useUserRolesWithProfiles();

  // Combine enrollment and invitation data
  const combinedData = useMemo<EnrollmentTableRow[]>(() => {
    const enrollmentRows: EnrollmentTableRow[] = userRolesData.map((role) => ({
      ...role,
      type: "enrollment" as const
    }));

    // Merge both arrays and perform a single stable sort
    const allRows = [...enrollmentRows, ...invitations];

    allRows.sort((a, b) => {
      if (a.type === "enrollment" && b.type === "invitation") return -1;
      if (a.type === "invitation" && b.type === "enrollment") return 1;
      if (a.type === "enrollment" && b.type === "enrollment") {
        return (a.profiles?.name || "").localeCompare(b.profiles?.name || "");
      }
      if (a.type === "invitation" && b.type === "invitation") {
        return (a.name || `${a.sis_user_id}` || "").localeCompare(b.name || `${b.sis_user_id}` || "");
      }
      return 0;
    });

    return allRows;
  }, [userRolesData, invitations]);

  // Create local table using react-table
  const table = useReactTable({
    data: combinedData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      sorting: [{ id: "profiles.name", desc: false }],
      pagination: {
        pageIndex: 0,
        pageSize: 1000
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
    const { error } = await supabase
      .from(params.resource as keyof Database["public"]["Tables"])
      .delete()
      .eq("id", params.id);
    if (error) throw error;
  };

  // CSV Export function
  const exportToCSV = useCallback(() => {
    // Use getFilteredRowModel to get ALL filtered data, not just what's displayed
    const filteredRows = table.getFilteredRowModel().rows;

    // Define CSV headers
    const headers = [
      "Status",
      "Name",
      "Email",
      "Role",
      "Class Section",
      "Lab Section",
      "GitHub Username",
      "GitHub Org Status",
      "SIS User ID",
      "SIS Linked",
      "Tags"
    ];

    // Convert data to CSV format
    const csvData = filteredRows.map((row) => {
      const original = row.original;

      // Get status
      let status = "Enrolled";
      if (original.type === "invitation") {
        const invitation = original;
        const isExpired = invitation.expires_at && new Date(invitation.expires_at) < new Date();
        status = invitation.status === "pending" && isExpired ? "Expired" : invitation.status;
      }

      // Get name
      const name =
        original.type === "invitation"
          ? original.name || `${original.sis_user_id}` || "N/A"
          : original.profiles?.name || "N/A";

      // Get email
      const email = original.type === "invitation" ? original.email || "N/A" : original.users?.email || "N/A";

      // Get role
      const role = original.role || "N/A";

      // Get class section
      let classSection = "Not assigned";
      if (original.type === "invitation") {
        if (original.class_section_id && classSections) {
          const section = classSections.find((s) => s.id === original.class_section_id);
          classSection = section ? section.name || `Section ${section.id}` : "Not assigned";
        }
      } else {
        if (original.class_section_id && classSections) {
          const section = classSections.find((s) => s.id === original.class_section_id);
          classSection = section ? section.name || `Section ${section.id}` : "Not assigned";
        }
      }

      // Get lab section
      let labSection = "Not assigned";
      if (original.type === "invitation") {
        if (original.lab_section_id && labSections) {
          const section = labSections.find((s) => s.id === original.lab_section_id);
          labSection = section ? section.name || `Lab ${section.id}` : "Not assigned";
        }
      } else {
        if (original.lab_section_id && labSections) {
          const section = labSections.find((s) => s.id === original.lab_section_id);
          labSection = section ? section.name || `Lab ${section.id}` : "Not assigned";
        }
      }

      // Get GitHub username
      const githubUsername = original.type === "invitation" ? "N/A" : original.users?.github_username || "N/A";

      // Get GitHub org status
      const githubOrgStatus =
        original.type === "invitation" ? "N/A" : original.github_org_confirmed ? "Joined" : "Not joined";

      // Get SIS User ID
      const sisUserId =
        original.type === "invitation"
          ? original.sis_user_id?.toString() || "N/A"
          : original.users?.sis_user_id?.toString() || "N/A";

      // Get SIS Linked status
      const sisLinked = original.type === "invitation" ? "N/A" : original.canvas_id ? "Yes" : "No";

      // Get tags
      let tags = "N/A (Pending)";
      if (original.type === "enrollment") {
        const profileTags = tagData
          .filter((tag) => {
            return tag.profile_id === original.private_profile_id || tag.profile_id === original.public_profile_id;
          })
          .map((tag) => tag.name);
        tags = profileTags.length > 0 ? profileTags.join("; ") : "No tags";
      }

      return [
        status,
        name,
        email,
        role,
        classSection,
        labSection,
        githubUsername,
        githubOrgStatus,
        sisUserId,
        sisLinked,
        tags
      ];
    });

    // Create CSV content
    const csvContent = [
      headers.join(","),
      ...csvData.map((row) => row.map((cell) => `"${cell.toString().replace(/"/g, '""')}"`).join(","))
    ].join("\n");

    // Create and download file
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `enrollments-${course_id}-${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [table, classSections, labSections, tagData, course_id]);

  return (
    <VStack align="start" w="100%">
      <VStack paddingBottom="55px" align="start" w="100%">
        <Box p="2" borderTop="1px solid" borderColor="border.muted" width="100%" mt={4}>
          <HStack justifyContent="flex-end">
            {" "}
            <ImportStudentsCSVModal />
            <AddSingleCourseMember />
            {/* Export Button */}
            <Button onClick={exportToCSV} variant="surface">
              <Icon as={FaFileExport} />
              Export to CSV
            </Button>
          </HStack>
        </Box>

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
                              }[header.column.getIsSorted() as string] ?? " 🔄"}
                            </Text>
                            {header.id === "checkbox" && (
                              <Checkbox.Root
                                checked={checkedBoxes.size === getRowModel().rows.length}
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
                            {header.id === "status" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={[
                                  { label: "Enrolled", value: "Enrolled" },
                                  { label: "Pending", value: "pending" },
                                  { label: "Accepted", value: "accepted" },
                                  { label: "Cancelled", value: "cancelled" },
                                  { label: "Expired", value: "Expired" },
                                  { label: "Dropped", value: "Dropped" }
                                ]}
                                placeholder="Filter by status..."
                              />
                            )}
                            {header.id === "profiles.name" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={Array.from(
                                  combinedData
                                    .reduce((map, row) => {
                                      const name =
                                        row.type === "invitation"
                                          ? row.name || `${row.sis_user_id}` || "N/A"
                                          : row.profiles?.name || "N/A";
                                      if (name && !map.has(name)) {
                                        map.set(name, name);
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((name) => ({ label: name, value: name }))}
                                placeholder="Filter by name..."
                              />
                            )}
                            {header.id === "users.email" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={Array.from(
                                  combinedData
                                    .reduce((map, row) => {
                                      const email =
                                        row.type === "invitation" ? row.email || "N/A" : row.users?.email || "N/A";
                                      if (email && !map.has(email)) {
                                        map.set(email, email);
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((email) => ({ label: email, value: email }))}
                                placeholder="Filter by email..."
                              />
                            )}
                            {header.id === "role" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={Array.from(
                                  combinedData
                                    .reduce((map, row) => {
                                      if (row.role && !map.has(row.role)) {
                                        map.set(row.role, row.role);
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((role) => ({ label: role, value: role }))}
                                placeholder="Filter by role..."
                              />
                            )}
                            {header.id === "class_section" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={[
                                  ...Array.from(
                                    classSections
                                      .reduce((map, section) => {
                                        const name = section.name || `Section ${section.id}`;
                                        if (!map.has(name)) {
                                          map.set(name, name);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((name) => ({ label: name, value: name })),
                                  { label: "Not assigned", value: "Not assigned" }
                                ]}
                                placeholder="Filter by class section..."
                              />
                            )}
                            {header.id === "lab_section" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={[
                                  ...Array.from(
                                    labSections
                                      .reduce((map, section) => {
                                        const name = section.name || `Lab ${section.id}`;
                                        if (!map.has(name)) {
                                          map.set(name, name);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((name) => ({ label: name, value: name })),
                                  { label: "Not assigned", value: "Not assigned" }
                                ]}
                                placeholder="Filter by lab section..."
                              />
                            )}
                            {header.id === "github_username" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={Array.from(
                                  combinedData
                                    .filter((row) => row.type === "enrollment")
                                    .map((row) => row as UserRoleWithPrivateProfileAndUser & { type: "enrollment" })
                                    .reduce((map, row) => {
                                      const username = row.users?.github_username || "N/A";
                                      if (!map.has(username)) {
                                        map.set(username, username);
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((username) => ({ label: username, value: username }))}
                                placeholder="Filter by GitHub username..."
                              />
                            )}
                            {header.id === "github_org_confirmed" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={[
                                  { label: "Joined", value: "Joined" },
                                  { label: "Not joined", value: "Not joined" },
                                  { label: "N/A", value: "N/A" }
                                ]}
                                placeholder="Filter by GitHub org status..."
                              />
                            )}
                            {header.id === "tags" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                  checkboxClear();
                                }}
                                options={[
                                  ...Array.from(
                                    tagData
                                      .reduce((map, p) => {
                                        if (!map.has(p.name)) {
                                          map.set(p.name, p.name);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((name) => ({ label: name, value: name })),
                                  { label: "N/A (Pending)", value: "N/A (Pending)" }
                                ]}
                                placeholder="Filter by tags..."
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
                          Array.from(checkedBoxes)
                            .filter((row) => row.type === "enrollment")
                            .map((profile) =>
                              addTag({
                                name: name.startsWith("~") ? name.slice(1) : name,
                                color: color || "gray",
                                visible: !name.startsWith("~"),
                                profile_id: (profile as UserRoleWithPrivateProfileAndUser & { type: "enrollment" })
                                  .private_profile_id,
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
                        .filter((row) => row.type === "enrollment")
                        .map(
                          (row) =>
                            (row as UserRoleWithPrivateProfileAndUser & { type: "enrollment" }).private_profile_id
                        )
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
                            const checkedProfileIds = Array.from(checkedBoxes)
                              .filter((row) => row.type === "enrollment")
                              .map(
                                (box) =>
                                  (box as UserRoleWithPrivateProfileAndUser & { type: "enrollment" }).private_profile_id
                              );

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
                        Array.from(checkedBoxes)
                          .filter((row) => row.type === "enrollment")
                          .map(async (profile) => {
                            const enrollmentProfile = profile as UserRoleWithPrivateProfileAndUser & {
                              type: "enrollment";
                            };
                            const findTag = tagData.find((tag) => {
                              return (
                                tag.name === tagName &&
                                tag.color === tagColor &&
                                tagVisibility === tag.visible &&
                                tag.profile_id === enrollmentProfile.private_profile_id
                              );
                            });
                            if (!findTag) {
                              toaster.error({
                                title: "Error removing tag",
                                description:
                                  "Tag not found on profile " + (enrollmentProfile.profiles?.name || "Unknown")
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
    </VStack>
  );
}
