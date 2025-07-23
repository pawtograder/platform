"use client";

import { Box, Flex, HStack, Stack, Text, Heading, Icon, Badge, VStack, Input } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { BsStar, BsStarFill, BsPerson, BsPlus, BsPencil, BsSearch } from "react-icons/bs";
import { formatDistanceToNow } from "date-fns";
import { Alert } from "@/components/ui/alert";
import useModalManager from "@/hooks/useModalManager";
import CreateKarmaEntryModal from "./modals/createKarmaEntryModal";
import EditKarmaEntryModal from "./modals/editKarmaEntryModal";
import { useOfficeHoursRealtime } from "@/hooks/useOfficeHoursRealtime";
import { useEffect, useState } from "react";
import type { StudentKarmaNotes, UserProfile } from "@/utils/supabase/DatabaseTypes";

type KarmaEntryWithDetails = StudentKarmaNotes & {
  student_profile?: UserProfile;
  created_by?: { name: string };
};

/**
 * Component for managing student karma scores and internal notes.
 * Allows instructors and TAs to track student behavior and participation.
 * Uses real-time updates to show karma changes immediately across all staff.
 */
export default function StudentKarmaManagement() {
  const { course_id } = useParams();
  const [searchTerm, setSearchTerm] = useState("");

  // Modal management
  const createModal = useModalManager();
  const editModal = useModalManager<KarmaEntryWithDetails>();

  // Set up real-time subscriptions for staff data including karma
  const {
    data: realtimeData,
    isConnected,
    connectionStatus,
    isLoading: realtimeLoading
  } = useOfficeHoursRealtime({
    classId: Number(course_id),
    enableGlobalQueues: false, // Not needed for karma
    enableStaffData: true // Enable staff data subscriptions
  });

  // Fetch all karma entries for the course with related data
  const {
    data: karmaResponse,
    isLoading: karmaLoading,
    error: karmaError,
    refetch: refetchKarma
  } = useList<KarmaEntryWithDetails>({
    resource: "student_karma_notes",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    sorters: [
      { field: "karma_score", order: "desc" },
      { field: "updated_at", order: "desc" }
    ],
    meta: {
      select: `
        *,
        student_profile:student_profile_id(*)
      `
    }
  });

  // Use realtime data when available, fallback to API data
  // Note: The realtime karma data comes from studentKarmaNotes array
  const karmaEntries = karmaResponse?.data ?? [];

  // Set up realtime message handling
  useEffect(() => {
    if (!isConnected) return;

    // Realtime updates are handled automatically by the hook
    // The controller will update the realtimeData when karma changes are broadcast
    console.log("Student karma management realtime connection established");
  }, [isConnected]);

  // Refresh karma data when realtime karma changes to get updated join data
  useEffect(() => {
    if (realtimeData.studentKarmaNotes.length > 0) {
      refetchKarma();
    }
  }, [realtimeData.studentKarmaNotes, refetchKarma]);

  const handleCreateSuccess = () => {
    createModal.closeModal();
    refetchKarma();
  };

  const handleEditSuccess = () => {
    editModal.closeModal();
    refetchKarma();
  };

  if (karmaLoading || realtimeLoading) return <Text>Loading student karma data...</Text>;
  if (karmaError) return <Alert status="error" title={`Error: ${karmaError.message}`} />;

  // Filter karma entries based on search term
  const filteredEntries = karmaEntries.filter((entry) => {
    if (!searchTerm.trim()) return true;
    const studentName = entry.student_profile?.name?.toLowerCase() || "";
    const notes = entry.internal_notes?.toLowerCase() || "";
    const search = searchTerm.toLowerCase();
    return studentName.includes(search) || notes.includes(search);
  });

  const getKarmaColor = (score: number) => {
    if (score >= 10) return "green";
    if (score >= 5) return "blue";
    if (score >= 0) return "yellow";
    if (score >= -5) return "orange";
    return "red";
  };

  const getKarmaLabel = (score: number) => {
    if (score >= 10) return "Excellent";
    if (score >= 5) return "Good";
    if (score >= 0) return "Neutral";
    if (score >= -5) return "Needs Attention";
    return "Problematic";
  };

  const renderStars = (score: number) => {
    const stars = [];
    const maxStars = 5;
    const normalizedScore = Math.min(Math.max(score, -10), 10); // Clamp between -10 and 10
    const filledStars = Math.ceil((normalizedScore + 10) / 4); // Convert to 0-5 scale

    for (let i = 0; i < maxStars; i++) {
      stars.push(<Icon key={i} as={i < filledStars ? BsStarFill : BsStar} color={getKarmaColor(score)} boxSize={4} />);
    }
    return stars;
  };

  const KarmaEntryCard = ({ entry }: { entry: KarmaEntryWithDetails }) => (
    <Box p={4} borderWidth="1px" borderRadius="md">
      <Flex justify="space-between" align="flex-start">
        <Box flex="1">
          <Flex align="center" gap={3} mb={2}>
            <Icon as={BsPerson} />
            <Text fontWeight="semibold">{entry.student_profile?.name || "Unknown Student"}</Text>
            <Badge colorPalette={getKarmaColor(entry.karma_score)} size="sm">
              {entry.karma_score} - {getKarmaLabel(entry.karma_score)}
            </Badge>
            {isConnected && (
              <Text fontSize="xs" color="green.500">
                ● Live
              </Text>
            )}
          </Flex>

          <HStack mb={3}>
            {renderStars(entry.karma_score)}
            <Text fontSize="sm" color="fg.subtle" ml={2}>
              ({entry.karma_score} points)
            </Text>
          </HStack>

          {entry.internal_notes && (
            <Box mb={3} p={3} borderRadius="md">
              <Text fontSize="sm" color="fg.subtle" fontStyle="italic">
                &ldquo;{entry.internal_notes}&rdquo;
              </Text>
            </Box>
          )}

          <HStack spaceX={4} fontSize="sm" color="fg.subtle">
            <Text>Updated {formatDistanceToNow(new Date(entry.updated_at), { addSuffix: true })}</Text>
            {entry.last_activity_at && (
              <Text>Last activity {formatDistanceToNow(new Date(entry.last_activity_at), { addSuffix: true })}</Text>
            )}
          </HStack>
        </Box>

        <HStack spaceX={2}>
          <Button size="sm" variant="outline" onClick={() => editModal.openModal(entry)}>
            <Icon as={BsPencil} />
            Edit
          </Button>
        </HStack>
      </Flex>
    </Box>
  );

  // Calculate statistics
  const totalEntries = karmaEntries.length;
  const averageKarma =
    totalEntries > 0 ? karmaEntries.reduce((sum, entry) => sum + entry.karma_score, 0) / totalEntries : 0;
  const positiveKarma = karmaEntries.filter((entry) => entry.karma_score > 0).length;
  const negativeKarma = karmaEntries.filter((entry) => entry.karma_score < 0).length;

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Student Karma Management</Heading>
        <Button onClick={() => createModal.openModal()}>
          <Icon as={BsPlus} />
          Add Karma Entry
        </Button>
      </Flex>

      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected" mb={4}>
          Karma changes may not appear immediately. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      {/* Statistics */}
      <HStack mb={6} gap={6}>
        <VStack align="start">
          <Text fontSize="sm">Total Students</Text>
          <Text fontSize="2xl" fontWeight="bold">
            {totalEntries}
          </Text>
        </VStack>
        <VStack align="start">
          <Text fontSize="sm">Average Karma</Text>
          <Flex align="center" gap={2}>
            <Text fontSize="2xl" fontWeight="bold" color={getKarmaColor(averageKarma)}>
              {averageKarma.toFixed(1)}
            </Text>
            {isConnected && (
              <Text fontSize="xs" color="green.500">
                ● Live
              </Text>
            )}
          </Flex>
        </VStack>
        <VStack align="start">
          <Text fontSize="sm">Positive Karma</Text>
          <Text fontSize="2xl" fontWeight="bold" color="green.500">
            {positiveKarma}
          </Text>
        </VStack>
        <VStack align="start">
          <Text fontSize="sm">Negative Karma</Text>
          <Text fontSize="2xl" fontWeight="bold" color="red.500">
            {negativeKarma}
          </Text>
        </VStack>
      </HStack>

      {/* Search */}
      <Box mb={6}>
        <HStack>
          <Icon as={BsSearch} />
          <Input
            placeholder="Search by student name or notes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            flex="1"
          />
          {isConnected && searchTerm.trim() && (
            <Text fontSize="xs" color="green.500">
              ● Live search
            </Text>
          )}
        </HStack>
      </Box>

      {/* Karma Entries List */}
      {filteredEntries.length === 0 ? (
        <Box textAlign="center" py={8}>
          <Icon as={BsStar} boxSize={12} mb={4} />
          <Text mb={4}>
            {searchTerm.trim()
              ? "No karma entries match your search criteria."
              : "No student karma entries have been created yet."}
          </Text>
          {!searchTerm.trim() && (
            <Button onClick={() => createModal.openModal()}>
              <Icon as={BsPlus} />
              Create First Karma Entry
            </Button>
          )}
        </Box>
      ) : (
        <Stack spaceY={3}>
          {filteredEntries.map((entry) => (
            <KarmaEntryCard key={entry.id} entry={entry} />
          ))}
          {isConnected && filteredEntries.length > 0 && (
            <Text fontSize="xs" color="green.500" textAlign="center">
              ● {filteredEntries.length} entries with live updates
            </Text>
          )}
        </Stack>
      )}

      {/* Modals */}
      <CreateKarmaEntryModal
        isOpen={createModal.isOpen}
        onClose={createModal.closeModal}
        onSuccess={handleCreateSuccess}
      />

      <EditKarmaEntryModal
        isOpen={editModal.isOpen}
        onClose={editModal.closeModal}
        onSuccess={handleEditSuccess}
        karmaEntry={editModal.modalData}
      />
    </Box>
  );
}
