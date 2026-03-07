"use client";

import { toaster } from "@/components/ui/toaster";
import { useAssignments } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { Box, Button as ChakraButton, Dialog, HStack, Icon, Stack, Text, Badge } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { BsPencil, BsTrash, BsX, BsPlus } from "react-icons/bs";
import { ErrorPinModal } from "./ErrorPinModal";

interface ErrorPinManageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  discussion_thread_id: number;
  defaultAssignmentId?: number | null;
}

type ErrorPinWithRules = Database["public"]["Tables"]["error_pins"]["Row"] & {
  rule_count: number;
  match_count: number;
};

export function ErrorPinManageModal({
  isOpen,
  onClose,
  onSuccess,
  discussion_thread_id,
  defaultAssignmentId
}: ErrorPinManageModalProps) {
  const { course_id } = useParams();
  const assignments = useAssignments();
  const [pins, setPins] = useState<ErrorPinWithRules[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingPinId, setDeletingPinId] = useState<number | null>(null);
  const [editingPinId, setEditingPinId] = useState<number | null>(null);

  const fetchPins = useCallback(async () => {
    if (!discussion_thread_id || !course_id) return;

    setLoading(true);
    try {
      const supabase = createClient();

      // Fetch pins
      const { data: pinsData, error: pinsError } = await supabase
        .from("error_pins")
        .select("*")
        .eq("discussion_thread_id", discussion_thread_id)
        .eq("class_id", Number(course_id))
        .order("created_at", { ascending: false });

      if (pinsError) throw pinsError;

      // Fetch counts for each pin
      const pinsWithCounts: ErrorPinWithRules[] = await Promise.all(
        (pinsData || []).map(async (pin) => {
          // Get rule count
          const { count: ruleCount } = await supabase
            .from("error_pin_rules")
            .select("*", { count: "exact", head: true })
            .eq("error_pin_id", pin.id);

          // Get match count
          const { count: matchCount } = await supabase
            .from("error_pin_submission_matches")
            .select("*", { count: "exact", head: true })
            .eq("error_pin_id", pin.id);

          return {
            ...pin,
            rule_count: ruleCount || 0,
            match_count: matchCount || 0
          };
        })
      );

      setPins(pinsWithCounts);
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to load error pins: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setLoading(false);
    }
  }, [discussion_thread_id, course_id]);

  useEffect(() => {
    if (isOpen) {
      fetchPins();
      setEditingPinId(null);
    }
  }, [isOpen, fetchPins]);

  const handleDelete = useCallback(
    async (pinId: number) => {
      if (
        !confirm(
          "Are you sure you want to delete this error pin? This will also delete all associated rules and matching submissions."
        )
      ) {
        return;
      }

      setDeletingPinId(pinId);
      try {
        const supabase = createClient();
        const { error } = await supabase.from("error_pins").delete().eq("id", pinId);

        if (error) throw error;

        toaster.success({
          title: "Success",
          description: "Error pin deleted successfully"
        });

        await fetchPins();
        onSuccess();
      } catch (error) {
        toaster.error({
          title: "Error",
          description: `Failed to delete error pin: ${error instanceof Error ? error.message : String(error)}`
        });
      } finally {
        setDeletingPinId(null);
      }
    },
    [fetchPins, onSuccess]
  );

  const handleEdit = useCallback((pinId: number) => {
    setEditingPinId(pinId);
  }, []);

  const handleCreateNew = useCallback(() => {
    setEditingPinId(0); // Use 0 to indicate "create new" mode
  }, []);

  const handleEditClose = useCallback(() => {
    setEditingPinId(null);
    fetchPins();
  }, [fetchPins]);

  const getAssignmentTitle = (assignmentId: number | null) => {
    if (assignmentId === null) return "All Assignments (Class-Level)";
    const assignment = assignments.find((a) => a.id === assignmentId);
    return assignment?.title || `Assignment #${assignmentId}`;
  };

  return (
    <>
      <Dialog.Root open={isOpen && editingPinId === null} onOpenChange={({ open }) => !open && onClose()} size="xl">
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Manage Error Pins</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <ChakraButton variant="ghost" colorPalette="red" size="sm" aria-label="Close Modal">
                  <Icon as={BsX} />
                </ChakraButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body>
              <Text fontSize="xs" color="fg.muted" mb={4} lineHeight="tall">
                Error Pins automatically link this discussion thread to student submissions that match specific error
                patterns. When a student&apos;s submission matches your defined rules, they&apos;ll see a link to this
                discussion thread directly in their test results, helping them find relevant help quickly. Create pins
                by defining rules that match against test outputs, scores, lint errors, or other submission data.
              </Text>

              {loading ? (
                <Text>Loading pins...</Text>
              ) : pins.length === 0 ? (
                <Stack spaceY={4}>
                  <Text color="fg.muted">No error pins found for this discussion thread.</Text>
                  <ChakraButton colorPalette="green" onClick={handleCreateNew}>
                    <Icon as={BsPlus} mr={2} />
                    Create First Error Pin
                  </ChakraButton>
                </Stack>
              ) : (
                <Stack spaceY={3}>
                  <HStack justify="space-between" mb={2}>
                    <Text fontWeight="semibold">
                      {pins.length} Error Pin{pins.length !== 1 ? "s" : ""}
                    </Text>
                    <ChakraButton size="sm" colorPalette="green" onClick={handleCreateNew}>
                      <Icon as={BsPlus} mr={1} />
                      Create New Pin
                    </ChakraButton>
                  </HStack>

                  {pins.map((pin) => (
                    <Box key={pin.id} border="1px solid" borderColor="border.emphasized" borderRadius="md" p={4}>
                      <HStack justify="space-between" mb={2}>
                        <HStack gap={2} flexWrap="wrap">
                          <Text fontWeight="semibold">{getAssignmentTitle(pin.assignment_id)}</Text>
                          {pin.assignment_id === null && <Badge colorPalette="purple">Class-Level</Badge>}
                          {pin.enabled ? (
                            <Badge colorPalette="green">Enabled</Badge>
                          ) : (
                            <Badge colorPalette="gray">Disabled</Badge>
                          )}
                          <Badge colorPalette="blue">
                            {pin.rule_count} Rule{pin.rule_count !== 1 ? "s" : ""}
                          </Badge>
                          <Badge colorPalette="cyan">
                            {pin.match_count} Match{pin.match_count !== 1 ? "es" : ""}
                          </Badge>
                          <Text fontSize="sm" color="fg.muted">
                            Logic: {pin.rule_logic.toUpperCase()}
                          </Text>
                        </HStack>
                        <HStack gap={2}>
                          <ChakraButton
                            size="sm"
                            variant="outline"
                            onClick={() => handleEdit(pin.id)}
                            disabled={deletingPinId === pin.id}
                          >
                            <Icon as={BsPencil} mr={1} />
                            Edit
                          </ChakraButton>
                          <ChakraButton
                            size="sm"
                            variant="outline"
                            colorPalette="red"
                            onClick={() => handleDelete(pin.id)}
                            loading={deletingPinId === pin.id}
                            disabled={deletingPinId !== null}
                          >
                            <Icon as={BsTrash} mr={1} />
                            Delete
                          </ChakraButton>
                        </HStack>
                      </HStack>
                    </Box>
                  ))}
                </Stack>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>

      {editingPinId !== null && (
        <ErrorPinModal
          isOpen={true}
          onClose={handleEditClose}
          onSuccess={() => {
            handleEditClose();
            onSuccess();
          }}
          discussion_thread_id={discussion_thread_id}
          existingPinId={editingPinId === 0 ? undefined : editingPinId}
          defaultAssignmentId={defaultAssignmentId}
        />
      )}
    </>
  );
}
