"use client";

import { useCourseController } from "@/hooks/useCourseController";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  Box,
  CardBody,
  CardHeader,
  CardRoot,
  DataListItem,
  DataListItemLabel,
  DataListItemValue,
  DataListRoot,
  Heading,
  Stack,
  Text
} from "@chakra-ui/react";
import { format } from "date-fns";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useTableControllerTableValues, useIsTableControllerReady } from "@/lib/TableController";

const DAYS_OF_WEEK: { value: string; label: string }[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" }
];

// Custom styled CardRoot with reduced padding (matching instructorDashboard)
const CompactCardRoot = ({ children, ...props }: React.ComponentProps<typeof CardRoot>) => (
  <CardRoot
    {...props}
    css={{
      "& .chakra-card__header": {
        padding: "0.75rem !important"
      },
      "& .chakra-card__body": {
        padding: "0.75rem !important",
        paddingTop: "0 !important"
      }
    }}
  >
    {children}
  </CardRoot>
);

// Custom styled DataListRoot with reduced vertical spacing (matching instructorDashboard)
const CompactDataListRoot = ({ children, ...props }: React.ComponentProps<typeof DataListRoot>) => (
  <DataListRoot
    {...props}
    css={{
      gap: 1,
      "& > *": {
        marginBottom: "0 !important",
        paddingBottom: "0 !important"
      },
      "& > *:last-child": {
        marginBottom: "0 !important",
        paddingBottom: "0 !important"
      }
    }}
  >
    {children}
  </DataListRoot>
);

export function AssignedLabSections() {
  const controller = useCourseController();
  const { private_profile_id } = useClassProfiles();
  const { course_id } = useParams();
  const router = useRouter();

  const sectionsReady = useIsTableControllerReady(controller.labSections);
  const leadersReady = useIsTableControllerReady(controller.labSectionLeaders);
  const profilesReady = useIsTableControllerReady(controller.profiles);

  // Get all lab sections
  const labSections = useTableControllerTableValues(controller.labSections);

  // Get all lab section leaders
  const labSectionLeaders = useTableControllerTableValues(controller.labSectionLeaders);

  // Get all profiles for leader names
  const profiles = useTableControllerTableValues(controller.profiles);

  // Filter lab sections where the current user is a leader
  const myLabSections = useMemo(() => {
    if (!private_profile_id || !labSectionLeaders || labSectionLeaders.length === 0) {
      return [];
    }

    const mySectionIds = new Set(
      labSectionLeaders
        .filter((leader) => leader.profile_id === private_profile_id)
        .map((leader) => leader.lab_section_id)
    );

    return labSections.filter((section) => mySectionIds.has(section.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [labSections, labSectionLeaders, private_profile_id]);

  // Create a map of section ID to leader names
  const sectionLeadersMap = useMemo(() => {
    const map = new Map<number, string[]>();
    if (!profiles || profiles.length === 0) return map;

    const profileMap = new Map(profiles.map((p) => [p.id, p.name || "Unknown"]));

    labSectionLeaders.forEach((leader) => {
      const sectionId = leader.lab_section_id;
      const leaderName = profileMap.get(leader.profile_id) || "Unknown";
      if (!map.has(sectionId)) {
        map.set(sectionId, []);
      }
      map.get(sectionId)!.push(leaderName);
    });

    return map;
  }, [labSectionLeaders, profiles]);

  const formatTime = useCallback((time: string) => {
    return format(new Date(`2000-01-01T${time}`), "h:mm a");
  }, []);

  const getDayDisplayName = useCallback((day: string) => {
    return DAYS_OF_WEEK.find((d) => d.value === day)?.label || day;
  }, []);

  const handleCardClick = useCallback(
    (labSectionId: number) => {
      router.push(`/course/${course_id}/manage/course/lab-roster?select=${labSectionId}`);
    },
    [course_id, router]
  );

  // Don't show anything if not ready or no assigned sections
  if (!sectionsReady || !leadersReady || !profilesReady) {
    return null;
  }

  if (myLabSections.length === 0) {
    return null;
  }

  return (
    <Box>
      <Heading size="lg" mb={4}>
        My Lab Sections
      </Heading>
      <Stack spaceY={4}>
        {myLabSections.map((section) => {
          const leaders = sectionLeadersMap.get(section.id) || [];
          return (
            <CompactCardRoot
              key={section.id}
              cursor="pointer"
              onClick={() => handleCardClick(section.id)}
              _hover={{ bg: "bg.subtle" }}
            >
              <CardHeader>
                <Text fontWeight="semibold">{section.name}</Text>
              </CardHeader>
              <CardBody>
                <CompactDataListRoot orientation="horizontal">
                  <DataListItem>
                    <DataListItemLabel>Schedule</DataListItemLabel>
                    <DataListItemValue>
                      <Text fontSize="sm">
                        {section.day_of_week ? getDayDisplayName(section.day_of_week) : "N/A"}
                        {section.start_time && ` • ${formatTime(section.start_time)}`}
                        {section.end_time && ` - ${formatTime(section.end_time)}`}
                      </Text>
                    </DataListItemValue>
                  </DataListItem>
                  {section.meeting_location && (
                    <DataListItem>
                      <DataListItemLabel>Location</DataListItemLabel>
                      <DataListItemValue>
                        <Text fontSize="sm">{section.meeting_location}</Text>
                      </DataListItemValue>
                    </DataListItem>
                  )}
                  {leaders.length > 0 && (
                    <DataListItem>
                      <DataListItemLabel>Facilitators</DataListItemLabel>
                      <DataListItemValue>
                        <Text fontSize="sm">{leaders.join(", ")}</Text>
                      </DataListItemValue>
                    </DataListItem>
                  )}
                </CompactDataListRoot>
              </CardBody>
            </CompactCardRoot>
          );
        })}
      </Stack>
    </Box>
  );
}
