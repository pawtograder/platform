"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { useStudentRoster } from "@/hooks/useClassProfiles";
import useModalManager from "@/hooks/useModalManager";
import { useConnectionStatus, useStudentKarmaNotes } from "@/hooks/useOfficeHoursRealtime";
import type { StudentKarmaNotes, UserProfile } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Flex, Heading, HStack, Icon, Input, Stack, Text, VStack } from "@chakra-ui/react";
import { useDelete } from "@refinedev/core";
import { formatDistanceToNow } from "date-fns";
import { useMemo, useState } from "react";
import { BsPencil, BsPerson, BsPlus, BsSearch, BsStar, BsStarFill, BsTrash } from "react-icons/bs";
import CreateKarmaEntryModal from "./modals/createKarmaEntryModal";
import EditKarmaEntryModal from "./modals/editKarmaEntryModal";

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
  const [searchTerm, setSearchTerm] = useState("");

  // Modal management
  const createModal = useModalManager();
  const editModal = useModalManager<KarmaEntryWithDetails>();

  // Get real-time karma notes data
  const karmaNotesData = useStudentKarmaNotes();

  // Delete mutation
  const { mutate: deleteKarmaEntry } = useDelete();

  // Set up real-time connection status monitoring
  const {
    isConnected,
    connectionStatus,
    isLoading: realtimeLoading
  } = useConnectionStatus();

  // Get all student profiles from the class
  const studentProfiles = useStudentRoster();

  // Create a map of profile ID to profile for easy lookup
  const profilesMap = useMemo(() => {
    const map = new Map<string, UserProfile>();
    studentProfiles.forEach((profile) => {
      map.set(profile.id, profile);
    });
    return map;
  }, [studentProfiles]);

  // Combine karma notes with profile data
  const karmaEntries: KarmaEntryWithDetails[] = useMemo(() => {
    return karmaNotesData.map((note) => ({
      ...note,
      student_profile: note.student_profile_id ? profilesMap.get(note.student_profile_id) : undefined
    }));
  }, [karmaNotesData, profilesMap]);

  // Filter and sort karma entries based on search term
  const filteredEntries = useMemo(() => {
    const filtered = karmaEntries.filter((entry) => {
      if (!searchTerm.trim()) return true;
      const studentName = entry.student_profile?.name?.toLowerCase() || "";
      const notes = entry.internal_notes?.toLowerCase() || "";
      const search = searchTerm.toLowerCase();
      return studentName.includes(search) || notes.includes(search);
    });

    // Sort by karma score (descending) then by updated_at (descending)
    return filtered.sort((a, b) => {
      if (a.karma_score !== b.karma_score) {
        return b.karma_score - a.karma_score;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [karmaEntries, searchTerm]);

  const handleCreateSuccess = () => {
    createModal.closeModal();
    // Real-time updates will automatically refresh the data
  };

  const handleEditSuccess = () => {
    editModal.closeModal();
    // Real-time updates will automatically refresh the data
  };

  const handleDeleteKarmaEntry = (entryId: number, studentName: string) => {
    deleteKarmaEntry(
      {
        resource: "student_karma_notes",
        id: entryId
      },
      {
        onSuccess: () => {
          toaster.success({
            title: "Karma entry deleted",
            description: `Karma entry for ${studentName} has been deleted successfully.`
          });
          // Real-time updates will automatically refresh the data
        },
        onError: (error) => {
          toaster.error({
            title: "Failed to delete karma entry",
            description: error.message || "An error occurred while deleting the karma entry."
          });
        }
      }
    );
  };

  const isLoading = realtimeLoading;

  if (isLoading) return <Text>Loading student karma data...</Text>;

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
          <Button size="sm" onClick={() => editModal.openModal(entry)}>
            <Icon as={BsPencil} />
            Edit
          </Button>
          <PopConfirm
            triggerLabel="Delete karma entry"
            trigger={
              <Button size="sm" colorPalette="red">
                <Icon as={BsTrash} />
                Delete
              </Button>
            }
            confirmHeader="Delete Karma Entry"
            confirmText={`Are you sure you want to delete the karma entry for ${entry.student_profile?.name || "this student"}? This action cannot be undone.`}
            onConfirm={() => handleDeleteKarmaEntry(entry.id, entry.student_profile?.name || "Unknown Student")}
            onCancel={() => {}}
          />
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
          {filteredEntries.length === 1 && <Text textAlign="center">{filteredEntries.length} entry found</Text>}
          {filteredEntries.length > 1 && <Text textAlign="center">{filteredEntries.length} entries found</Text>}
          {filteredEntries.map((entry) => (
            <KarmaEntryCard key={entry.id} entry={entry} />
          ))}
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
