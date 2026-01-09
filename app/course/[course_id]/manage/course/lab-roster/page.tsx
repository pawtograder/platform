"use client";

import { Button } from "@/components/ui/button";
import { Toaster, toaster } from "@/components/ui/toaster";
import { useClassProfiles, useIsInstructor } from "@/hooks/useClassProfiles";
import { useCourseController, useLabSections, useUserRolesWithProfiles } from "@/hooks/useCourseController";
import { useTableControllerTableValues } from "@/lib/TableController";
import { LabSection, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import {
  Accordion,
  Alert,
  Badge,
  Box,
  Card,
  Container,
  Heading,
  HStack,
  Icon,
  SimpleGrid,
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
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaChalkboardTeacher, FaCog, FaFileExport, FaUsers } from "react-icons/fa";
import { MdOutlineScience } from "react-icons/md";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import StudentSummaryTrigger from "@/components/ui/student-summary";
import Link from "next/link";

type StudentWithSection = UserRoleWithPrivateProfileAndUser & {
  labSectionName: string;
};

// Helper function to get day of week order (Monday = 0, Tuesday = 1, ..., Sunday = 6)
function getDayOrder(day: string | null): number {
  const dayMap: Record<string, number> = {
    monday: 0,
    tuesday: 1,
    wednesday: 2,
    thursday: 3,
    friday: 4,
    saturday: 5,
    sunday: 6
  };
  return dayMap[day?.toLowerCase() || ""] ?? 999; // Unknown days go to end
}

// Sort lab sections by day of week, then by start time
function sortLabSections(a: LabSection, b: LabSection): number {
  // First compare by day of week
  const dayA = getDayOrder(a.day_of_week);
  const dayB = getDayOrder(b.day_of_week);

  if (dayA !== dayB) {
    return dayA - dayB;
  }

  // If same day, compare by start time
  const timeA = a.start_time || "";
  const timeB = b.start_time || "";

  if (timeA && timeB) {
    return timeA.localeCompare(timeB);
  }

  // If one has time and other doesn't, prioritize the one with time
  if (timeA && !timeB) return -1;
  if (!timeA && timeB) return 1;

  // If both have no time, fall back to name
  return a.name.localeCompare(b.name);
}

export default function LabRosterPage() {
  const { course_id } = useParams();
  const controller = useCourseController();
  const { private_profile_id } = useClassProfiles();
  const isInstructor = useIsInstructor();
  const labSections = useLabSections();
  const userRoles = useUserRolesWithProfiles();
  const labSectionLeaders = useTableControllerTableValues(controller.labSectionLeaders);
  const profiles = useTableControllerTableValues(controller.profiles);

  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null);
  const [isOtherSectionsOpen, setIsOtherSectionsOpen] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Determine which sections the current user leads
  const mySectionIds = useMemo(() => {
    return new Set(
      labSectionLeaders
        .filter((leader) => leader.profile_id === private_profile_id)
        .map((leader) => leader.lab_section_id)
    );
  }, [labSectionLeaders, private_profile_id]);

  // Get the lab sections the user leads with full details
  const mySections = useMemo(() => {
    return labSections.filter((section) => mySectionIds.has(section.id)).sort(sortLabSections);
  }, [labSections, mySectionIds]);

  // Get other lab sections (not led by user)
  const otherSections = useMemo(() => {
    return labSections.filter((section) => !mySectionIds.has(section.id)).sort(sortLabSections);
  }, [labSections, mySectionIds]);

  // Initialize selection to first section in list, and accordion state
  useEffect(() => {
    if (!isInitialized && labSections.length > 0 && labSectionLeaders.length >= 0) {
      // If user has no sections, expand other sections accordion by default
      if (mySections.length === 0) {
        setIsOtherSectionsOpen(true);
        // Select first other section if available
        if (otherSections.length > 0) {
          setSelectedSectionId(otherSections[0].id);
        }
      } else {
        // Select first of my sections
        setSelectedSectionId(mySections[0].id);
      }

      setIsInitialized(true);
    }
  }, [labSections, labSectionLeaders, mySections, otherSections, isInitialized]);

  // Create a map from section ID to section name
  const sectionIdToName = useMemo(() => {
    const map = new Map<number, string>();
    for (const section of labSections) {
      map.set(section.id, section.name);
    }
    return map;
  }, [labSections]);

  // Get selected section details
  const selectedSection = useMemo(() => {
    if (!selectedSectionId) return null;
    return labSections.find((s) => s.id === selectedSectionId) || null;
  }, [labSections, selectedSectionId]);

  // Filter students to only those in selected section and role = student
  const studentsInSelectedSection = useMemo<StudentWithSection[]>(() => {
    if (!selectedSectionId) return [];

    return userRoles
      .filter((role) => role.role === "student" && !role.disabled && role.lab_section_id === selectedSectionId)
      .map((role) => ({
        ...role,
        labSectionName: sectionIdToName.get(role.lab_section_id!) || "Unknown Section"
      }))
      .sort((a, b) => (a.profiles?.name || "").localeCompare(b.profiles?.name || ""));
  }, [userRoles, selectedSectionId, sectionIdToName]);

  // Create a map from profile_id to profile name
  const profileIdToName = useMemo(() => {
    const map = new Map<string, string>();
    profiles.forEach((profile) => {
      if (profile.name) {
        map.set(profile.id, profile.name);
      }
    });
    return map;
  }, [profiles]);

  // Create a map from lab_section_id to leader names
  const sectionIdToLeaderNames = useMemo(() => {
    const map = new Map<number, string[]>();
    labSectionLeaders.forEach((leader) => {
      const sectionId = leader.lab_section_id;
      const leaderName = profileIdToName.get(leader.profile_id);
      if (leaderName) {
        if (!map.has(sectionId)) {
          map.set(sectionId, []);
        }
        map.get(sectionId)!.push(leaderName);
      }
    });
    return map;
  }, [labSectionLeaders, profileIdToName]);

  // Count students in each of my sections for the summary
  const mySectionsWithCounts = useMemo(() => {
    return mySections.map((section) => {
      const studentCount = userRoles.filter(
        (role) => role.role === "student" && !role.disabled && role.lab_section_id === section.id
      ).length;
      const leaderNames = sectionIdToLeaderNames.get(section.id) || [];
      return { ...section, studentCount, leaderNames };
    });
  }, [mySections, userRoles, sectionIdToLeaderNames]);

  // Count students in other sections
  const otherSectionsWithCounts = useMemo(() => {
    return otherSections.map((section) => {
      const studentCount = userRoles.filter(
        (role) => role.role === "student" && !role.disabled && role.lab_section_id === section.id
      ).length;
      const leaderNames = sectionIdToLeaderNames.get(section.id) || [];
      return { ...section, studentCount, leaderNames };
    });
  }, [otherSections, userRoles, sectionIdToLeaderNames]);

  // Table columns
  const columns = useMemo<ColumnDef<StudentWithSection>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        accessorFn: (row) => row.profiles?.name || "N/A",
        cell: ({ row }) => {
          const name = row.original.profiles?.name;
          const profileId = row.original.private_profile_id;
          return (
            <HStack gap={2}>
              <StudentSummaryTrigger student_id={profileId} course_id={Number(course_id)} />
              <Text fontWeight="medium">{name || "N/A"}</Text>
            </HStack>
          );
        }
      },
      {
        id: "email",
        header: "Email",
        accessorFn: (row) => row.users?.email || "N/A",
        cell: ({ row }) => {
          const email = row.original.users?.email;
          return <Text>{email || "N/A"}</Text>;
        }
      },
      {
        id: "github_username",
        header: "GitHub Username",
        accessorFn: (row) => row.users?.github_username || "N/A",
        cell: ({ row }) => {
          const username = row.original.users?.github_username;
          return <Text color={username ? undefined : "fg.muted"}>{username || "N/A"}</Text>;
        }
      }
    ],
    [course_id]
  );

  // CSV Export function
  const exportToCSV = useCallback(() => {
    if (studentsInSelectedSection.length === 0) {
      toaster.error({
        title: "No data to export",
        description: "There are no students in the selected section to export."
      });
      return;
    }

    const headers = ["Lab Section", "Name", "Email", "GitHub Username"];

    const csvData = studentsInSelectedSection.map((student) => [
      student.labSectionName,
      student.profiles?.name || "N/A",
      student.users?.email || "N/A",
      student.users?.github_username || "N/A"
    ]);

    const csvContent = [
      headers.join(","),
      ...csvData.map((row) => row.map((cell) => `"${cell.toString().replace(/"/g, '""')}"`).join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    const sectionName = selectedSection?.name?.replace(/[^a-zA-Z0-9]/g, "-") || "section";
    link.setAttribute("download", `lab-roster-${sectionName}-${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toaster.success({
      title: "Export successful",
      description: `Exported ${studentsInSelectedSection.length} students to CSV.`
    });
  }, [studentsInSelectedSection, selectedSection]);

  // Helper to format schedule
  const formatSchedule = (section: LabSection) => {
    const day = section.day_of_week ? section.day_of_week.charAt(0).toUpperCase() + section.day_of_week.slice(1) : "";
    const startTime = section.start_time
      ? new Date(`2000-01-01T${section.start_time}`).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        })
      : "";
    const endTime = section.end_time
      ? new Date(`2000-01-01T${section.end_time}`).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        })
      : "";

    if (day && startTime) {
      return `${day} ${startTime}${endTime ? ` - ${endTime}` : ""}`;
    }
    return "";
  };

  // Loading state
  if (!isInitialized) {
    return (
      <Container maxW="6xl">
        <VStack gap={4} mt={8}>
          <Spinner size="lg" />
          <Text>Loading lab roster...</Text>
        </VStack>
      </Container>
    );
  }

  return (
    <Container maxW="6xl">
      <VStack gap={6} mt={4} align="stretch">
        {/* Header */}
        <HStack justify="space-between" align="center">
          <Heading size="lg">Lab Sections</Heading>
          <HStack gap={2}>
            {isInstructor && (
              <Button asChild variant="outline">
                <Link href={`/course/${course_id}/manage/course/lab-sections`}>
                  <HStack gap={2}>
                    <FaCog />
                    <Text>Manage lab sections</Text>
                  </HStack>
                </Link>
              </Button>
            )}
            <Button onClick={exportToCSV} variant="surface" disabled={studentsInSelectedSection.length === 0}>
              <FaFileExport />
              Export to CSV
            </Button>
          </HStack>
        </HStack>

        {/* Info banner if user has no sections */}
        {mySectionsWithCounts.length === 0 && (
          <Alert.Root status="info">
            <Alert.Indicator>
              <Icon as={Info} />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Title>No Lab Sections Assigned</Alert.Title>
              <Alert.Description>
                You are not currently assigned to lead any lab sections. You can view other lab sections below.
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}

        {/* My Sections Summary */}
        {mySectionsWithCounts.length > 0 && (
          <Box>
            <HStack gap={2} mb={3}>
              <MdOutlineScience />
              <Text fontWeight="medium">Your Lab Sections</Text>
              <Badge colorPalette="blue" size="sm">
                {mySectionsWithCounts.length}
              </Badge>
            </HStack>
            <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} gap={3}>
              {mySectionsWithCounts.map((section) => (
                <Card.Root
                  key={section.id}
                  size="sm"
                  variant={selectedSectionId === section.id ? "outline" : "subtle"}
                  borderColor={selectedSectionId === section.id ? "blue.500" : undefined}
                  cursor="pointer"
                  onClick={() => setSelectedSectionId(section.id)}
                  _hover={{ borderColor: "blue.300" }}
                >
                  <Card.Body p={3}>
                    <VStack align="start" gap={1}>
                      <Text fontWeight="medium" fontSize="sm">
                        {section.name}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {formatSchedule(section)}
                      </Text>
                      {section.leaderNames && section.leaderNames.length > 0 && (
                        <HStack gap={1}>
                          <FaChalkboardTeacher size={12} />
                          <Text fontSize="xs" color="fg.muted">
                            {section.leaderNames.join(", ")}
                          </Text>
                        </HStack>
                      )}
                      <HStack gap={1}>
                        <FaUsers size={12} />
                        <Text fontSize="xs" color="fg.muted">
                          {section.studentCount} student{section.studentCount !== 1 ? "s" : ""}
                        </Text>
                      </HStack>
                    </VStack>
                  </Card.Body>
                </Card.Root>
              ))}
            </SimpleGrid>
          </Box>
        )}

        {/* Other Sections Accordion */}
        {otherSectionsWithCounts.length > 0 && (
          <Accordion.Root
            collapsible
            value={isOtherSectionsOpen ? ["other-sections"] : []}
            onValueChange={(details) => setIsOtherSectionsOpen(details.value.includes("other-sections"))}
          >
            <Accordion.Item value="other-sections">
              <Accordion.ItemTrigger
                _hover={{
                  bg: "bg.muted"
                }}
                borderRadius="md"
                p={3}
              >
                <HStack justify="space-between" width="100%">
                  <HStack gap={2}>
                    <MdOutlineScience />
                    <Text fontWeight="medium">Other Lab Sections</Text>
                    <Badge colorPalette="gray" size="sm">
                      {otherSectionsWithCounts.length}
                    </Badge>
                  </HStack>
                  <Icon color="fg.subtle">
                    {isOtherSectionsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </Icon>
                </HStack>
              </Accordion.ItemTrigger>
              <Accordion.ItemContent>
                <Box pt={3}>
                  <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} gap={3}>
                    {otherSectionsWithCounts.map((section) => (
                      <Card.Root
                        key={section.id}
                        size="sm"
                        variant={selectedSectionId === section.id ? "outline" : "subtle"}
                        borderColor={selectedSectionId === section.id ? "blue.500" : undefined}
                        cursor="pointer"
                        onClick={() => setSelectedSectionId(section.id)}
                        _hover={{ borderColor: "blue.300" }}
                      >
                        <Card.Body p={3}>
                          <VStack align="start" gap={1}>
                            <Text fontWeight="medium" fontSize="sm">
                              {section.name}
                            </Text>
                            <Text fontSize="xs" color="fg.muted">
                              {formatSchedule(section)}
                            </Text>
                            {section.leaderNames && section.leaderNames.length > 0 && (
                              <HStack gap={1}>
                                <FaChalkboardTeacher size={12} />
                                <Text fontSize="xs" color="fg.muted">
                                  {section.leaderNames.join(", ")}
                                </Text>
                              </HStack>
                            )}
                            <HStack gap={1}>
                              <FaUsers size={12} />
                              <Text fontSize="xs" color="fg.muted">
                                {section.studentCount} student{section.studentCount !== 1 ? "s" : ""}
                              </Text>
                            </HStack>
                          </VStack>
                        </Card.Body>
                      </Card.Root>
                    ))}
                  </SimpleGrid>
                </Box>
              </Accordion.ItemContent>
            </Accordion.Item>
          </Accordion.Root>
        )}

        {/* Content */}
        {!selectedSectionId ? (
          <Box p={8} textAlign="center" border="1px dashed" borderColor="border.muted" borderRadius="md">
            <Text color="fg.muted">Select a lab section to view students.</Text>
          </Box>
        ) : studentsInSelectedSection.length === 0 ? (
          <Box p={8} textAlign="center" border="1px dashed" borderColor="border.muted" borderRadius="md">
            <Text color="fg.muted">No students are enrolled in this lab section.</Text>
          </Box>
        ) : (
          <SectionTable
            sectionName={selectedSection?.name || "Unknown Section"}
            students={studentsInSelectedSection}
            columns={columns}
            labSections={labSections}
          />
        )}
      </VStack>
      <Toaster />
    </Container>
  );
}

function SectionTable({
  sectionName,
  students,
  columns,
  labSections
}: {
  sectionName: string;
  students: StudentWithSection[];
  columns: ColumnDef<StudentWithSection>[];
  labSections: LabSection[];
}) {
  const section = labSections.find((s) => s.name === sectionName);

  const table = useReactTable({
    data: students,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      sorting: [{ id: "name", desc: false }]
    }
  });

  const formatSchedule = (sec: LabSection) => {
    const day = sec.day_of_week ? sec.day_of_week.charAt(0).toUpperCase() + sec.day_of_week.slice(1) : "";
    const startTime = sec.start_time
      ? new Date(`2000-01-01T${sec.start_time}`).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        })
      : "";
    const endTime = sec.end_time
      ? new Date(`2000-01-01T${sec.end_time}`).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        })
      : "";

    if (day && startTime) {
      return `${day} ${startTime}${endTime ? ` - ${endTime}` : ""}`;
    }
    return "";
  };

  return (
    <Box borderWidth="1px" borderRadius="md" overflow="hidden">
      {/* Section Header */}
      <Box bg="bg.subtle" px={4} py={3} borderBottomWidth="1px">
        <HStack justify="space-between">
          <VStack align="start" gap={0}>
            <Text fontWeight="bold" fontSize="lg">
              {sectionName}
            </Text>
            {section && (
              <Text fontSize="sm" color="fg.muted">
                {formatSchedule(section)}
                {section.meeting_location && ` • ${section.meeting_location}`}
              </Text>
            )}
          </VStack>
          <Text color="fg.muted" fontSize="sm">
            {students.length} student{students.length !== 1 ? "s" : ""}
          </Text>
        </HStack>
      </Box>

      {/* Table */}
      <Table.Root>
        <Table.Header>
          {table.getHeaderGroups().map((headerGroup) => (
            <Table.Row key={headerGroup.id} bg="bg.muted">
              {headerGroup.headers.map((header) => (
                <Table.ColumnHeader key={header.id}>
                  <Text cursor="pointer" onClick={header.column.getToggleSortingHandler()} userSelect="none">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{
                      asc: " 🔼",
                      desc: " 🔽"
                    }[header.column.getIsSorted() as string] ?? ""}
                  </Text>
                </Table.ColumnHeader>
              ))}
            </Table.Row>
          ))}
        </Table.Header>
        <Table.Body>
          {table.getRowModel().rows.map((row) => (
            <Table.Row key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
