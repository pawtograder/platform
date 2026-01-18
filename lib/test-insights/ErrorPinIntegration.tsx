"use client";

import { toaster } from "@/components/ui/toaster";
import { useErrorPinsForPattern } from "@/hooks/useTestInsights";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Button, Card, Dialog, Field, HStack, Icon, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FaComments, FaLink, FaPlus, FaSearch } from "react-icons/fa";
import type { CommonErrorGroup, MatchingErrorPin } from "./types";

interface ErrorPinIntegrationProps {
  assignmentId: number;
  courseId: number;
  errorGroup: CommonErrorGroup;
  onClose: () => void;
  isOpen: boolean;
}

/**
 * Component for linking common errors to discussion posts via error pins.
 * Shows existing matching pins and allows creating new pins.
 */
export function ErrorPinIntegration({ assignmentId, courseId, errorGroup, onClose, isOpen }: ErrorPinIntegrationProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [discussionThreads, setDiscussionThreads] = useState<
    Array<{ id: number; subject: string; created_at: string }>
  >([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedThread, setSelectedThread] = useState<number | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Check for existing error pins that match this error
  const { data: matchingPins, isLoading: isLoadingPins } = useErrorPinsForPattern(
    assignmentId,
    errorGroup.test_name,
    errorGroup.sample_outputs[0] || ""
  );

  // Search discussion threads
  const searchThreads = useCallback(async () => {
    if (!searchTerm.trim()) {
      setDiscussionThreads([]);
      return;
    }

    setIsSearching(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("discussion_threads")
        .select("id, subject, created_at")
        .eq("class_id", courseId)
        .ilike("subject", `%${searchTerm}%`)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      setDiscussionThreads(data || []);
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to search threads: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsSearching(false);
    }
  }, [searchTerm, courseId]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (searchTerm.trim()) {
        searchThreads();
      }
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [searchTerm, searchThreads]);

  // Create error pin for the selected thread
  const createErrorPin = useCallback(async () => {
    if (!selectedThread) {
      toaster.error({
        title: "Error",
        description: "Please select a discussion thread"
      });
      return;
    }

    setIsCreating(true);
    try {
      const supabase = createClient();

      // Get the current user's profile
      const {
        data: { user }
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: profile } = await supabase
        .from("user_roles")
        .select("private_profile_id")
        .eq("class_id", courseId)
        .eq("user_id", user.id)
        .single();

      if (!profile?.private_profile_id) throw new Error("Profile not found");

      // Create the error pin with rules based on the error group
      const pinData = {
        discussion_thread_id: selectedThread,
        assignment_id: assignmentId,
        class_id: courseId,
        created_by: profile.private_profile_id,
        rule_logic: "and",
        enabled: true
      };

      // Create rules to match this error pattern
      const rules = [
        {
          target: "test_name",
          match_type: "equals",
          match_value: errorGroup.test_name,
          ordinal: 0
        },
        {
          target: "test_output",
          match_type: "contains",
          match_value: errorGroup.sample_outputs[0]?.slice(0, 200) || "",
          ordinal: 1
        }
      ];

      const { data, error } = await supabase.rpc("save_error_pin", {
        p_error_pin: pinData,
        p_rules: rules
      });

      if (error) throw error;

      const result = data as { success: boolean; error_pin_id: number; matches_populated: number } | null;

      toaster.success({
        title: "Success",
        description: `Error pin created! ${result?.matches_populated || 0} submissions matched.`
      });

      onClose();
    } catch (error) {
      toaster.error({
        title: "Error",
        description: `Failed to create error pin: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsCreating(false);
    }
  }, [selectedThread, assignmentId, courseId, errorGroup, onClose]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && onClose()} size="xl">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>
              <HStack>
                <Icon as={FaLink} />
                <Text>Link Error to Discussion</Text>
              </HStack>
            </Dialog.Title>
            <Dialog.CloseTrigger />
          </Dialog.Header>

          <Dialog.Body>
            <VStack align="stretch" gap={6}>
              {/* Error Summary */}
              <Card.Root bg="red.50" _dark={{ bg: "red.900" }}>
                <Card.Body>
                  <VStack align="start" gap={2}>
                    <HStack>
                      <Badge colorPalette="red">{errorGroup.test_name}</Badge>
                      <Badge colorPalette="purple">{errorGroup.occurrence_count} students affected</Badge>
                    </HStack>
                    <Text fontSize="sm" color="fg.muted" fontFamily="mono" truncate maxW="100%">
                      {errorGroup.error_signature}
                    </Text>
                  </VStack>
                </Card.Body>
              </Card.Root>

              {/* Existing Matching Pins */}
              {isLoadingPins ? (
                <HStack justify="center" p={4}>
                  <Spinner size="sm" />
                  <Text fontSize="sm" color="fg.muted">
                    Checking for existing error pins...
                  </Text>
                </HStack>
              ) : matchingPins?.matching_pins && matchingPins.matching_pins.length > 0 ? (
                <Box>
                  <Text fontWeight="semibold" mb={2}>
                    <Icon as={FaComments} mr={2} />
                    Existing Discussion Links
                  </Text>
                  <VStack align="stretch" gap={2}>
                    {matchingPins.matching_pins.map((pin: MatchingErrorPin) => (
                      <Card.Root key={pin.error_pin_id} variant="outline">
                        <Card.Body py={3}>
                          <HStack justify="space-between">
                            <VStack align="start" gap={0}>
                              <Text fontWeight="medium">{pin.thread_subject}</Text>
                              <Text fontSize="xs" color="fg.muted">
                                {pin.match_count} submissions linked
                              </Text>
                            </VStack>
                            <Button size="sm" variant="outline" asChild>
                              <NextLink
                                href={`/course/${courseId}/discussion/${pin.discussion_thread_id}`}
                                target="_blank"
                              >
                                View Thread
                              </NextLink>
                            </Button>
                          </HStack>
                        </Card.Body>
                      </Card.Root>
                    ))}
                  </VStack>
                </Box>
              ) : null}

              {/* Search and Create New Pin */}
              <Box>
                <Text fontWeight="semibold" mb={2}>
                  <Icon as={FaPlus} mr={2} />
                  Create New Error Pin
                </Text>

                <Field.Root mb={4}>
                  <Field.Label>Search Discussion Threads</Field.Label>
                  <HStack>
                    <Icon as={FaSearch} color="fg.muted" />
                    <Input
                      placeholder="Search by thread subject..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                  </HStack>
                </Field.Root>

                {isSearching ? (
                  <HStack justify="center" p={4}>
                    <Spinner size="sm" />
                  </HStack>
                ) : discussionThreads.length > 0 ? (
                  <Box maxH="200px" overflowY="auto" borderWidth="1px" borderRadius="md">
                    <VStack align="stretch" gap={0}>
                      {discussionThreads.map((thread) => (
                        <Box
                          key={thread.id}
                          p={3}
                          cursor="pointer"
                          bg={selectedThread === thread.id ? "blue.50" : "transparent"}
                          _dark={{
                            bg: selectedThread === thread.id ? "blue.900" : "transparent"
                          }}
                          _hover={{ bg: "bg.subtle" }}
                          borderBottomWidth="1px"
                          borderColor="border.muted"
                          onClick={() => setSelectedThread(thread.id)}
                        >
                          <Text fontWeight={selectedThread === thread.id ? "semibold" : "normal"}>
                            {thread.subject}
                          </Text>
                          <Text fontSize="xs" color="fg.muted">
                            Created {new Date(thread.created_at).toLocaleDateString()}
                          </Text>
                        </Box>
                      ))}
                    </VStack>
                  </Box>
                ) : searchTerm.trim() ? (
                  <Text color="fg.muted" fontSize="sm" textAlign="center" p={4}>
                    No threads found matching &ldquo;{searchTerm}&rdquo;
                  </Text>
                ) : (
                  <Text color="fg.muted" fontSize="sm" textAlign="center" p={4}>
                    Type to search for discussion threads
                  </Text>
                )}

                {selectedThread && (
                  <Box mt={4} p={4} bg="green.50" borderRadius="md" _dark={{ bg: "green.900" }}>
                    <Text fontSize="sm" color="green.700" _dark={{ color: "green.200" }}>
                      Selected thread will be linked to this error pattern. Students with matching errors will see a
                      link to this discussion.
                    </Text>
                  </Box>
                )}
              </Box>
            </VStack>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="flex-end" gap={3}>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button colorPalette="blue" onClick={createErrorPin} loading={isCreating} disabled={!selectedThread}>
                <Icon as={FaLink} mr={2} />
                Create Error Pin
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
