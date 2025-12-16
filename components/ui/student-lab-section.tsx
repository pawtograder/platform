"use client";

import { useCourseController } from "@/hooks/useCourseController";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { LabSection } from "@/utils/supabase/DatabaseTypes";
import { Box, Card, Heading, HStack, Text, VStack } from "@chakra-ui/react";
import { format } from "date-fns";
import { Calendar, Clock, User } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { useEffect, useState } from "react";

const DAYS_OF_WEEK: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday"
};

export default function StudentLabSection() {
  const controller = useCourseController();
  const { role } = useClassProfiles();
  const supabase = createClient();
  const [labLeaders, setLabLeaders] = useState<string[]>([]);

  // Get lab sections data
  const { data: labSections } = controller.listLabSections();

  // Find the student's lab section
  const studentLabSection = labSections?.find((labSection: LabSection) => labSection.id === role?.lab_section_id);

  // Fetch lab section leaders
  useEffect(() => {
    const fetchLeaders = async () => {
      if (!studentLabSection?.id) {
        setLabLeaders([]);
        return;
      }

      const { data: leaders } = await supabase
        .from("lab_section_leaders")
        .select("profiles(name)")
        .eq("lab_section_id", studentLabSection.id);

      if (leaders) {
        const leaderNames = leaders
          .map((l) => (l.profiles as { name: string | null })?.name)
          .filter((name): name is string => name !== null);
        setLabLeaders(leaderNames);
      }
    };

    fetchLeaders();
  }, [studentLabSection?.id, supabase]);

  if (!studentLabSection) {
    return null; // Don't show anything if no lab section is assigned
  }

  const formatTime = (time: string) => {
    return format(new Date(`2000-01-01T${time}`), "h:mm a");
  };

  const getDayDisplayName = (day: string) => {
    return DAYS_OF_WEEK[day] || day;
  };

  return (
    <Card.Root>
      <Card.Header>
        <Heading size="md">Your Lab Section</Heading>
      </Card.Header>
      <Card.Body>
        <VStack gap={3} align="stretch">
          <HStack gap={3}>
            <User size={16} />
            <VStack gap={1} align="start">
              <Text fontSize="sm" color="fg.muted">
                Section
              </Text>
              <Text fontWeight="medium">{studentLabSection.name}</Text>
            </VStack>
          </HStack>

          <HStack gap={3}>
            <Calendar size={16} />
            <VStack gap={1} align="start">
              <Text fontSize="sm" color="fg.muted">
                Schedule
              </Text>
              <Text fontWeight="medium">
                {studentLabSection.day_of_week ? getDayDisplayName(studentLabSection.day_of_week) : "N/A"}
              </Text>
            </VStack>
          </HStack>

          <HStack gap={3}>
            <Clock size={16} />
            <VStack gap={1} align="start">
              <Text fontSize="sm" color="fg.muted">
                Time
              </Text>
              <Text fontWeight="medium">
                {studentLabSection.start_time ? formatTime(studentLabSection.start_time) : "N/A"}
                {studentLabSection.end_time && ` - ${formatTime(studentLabSection.end_time)}`}
              </Text>
            </VStack>
          </HStack>

          <HStack gap={3}>
            <User size={16} />
            <VStack gap={1} align="start">
              <Text fontSize="sm" color="fg.muted">
                Lab Leader{labLeaders.length > 1 ? "s" : ""}
              </Text>
              <Text fontWeight="medium">
                {labLeaders.length > 0 ? labLeaders.join(", ") : "TBA"}
              </Text>
            </VStack>
          </HStack>

          {studentLabSection.description && (
            <Box pt={2} borderTop="1px solid" borderColor="border.muted">
              <Text fontSize="sm" color="fg.muted">
                {studentLabSection.description}
              </Text>
            </Box>
          )}
        </VStack>
      </Card.Body>
    </Card.Root>
  );
}
