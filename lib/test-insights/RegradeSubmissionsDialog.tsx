"use client";

import { toaster } from "@/components/ui/toaster";
import { rerunGrader } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  Dialog,
  HStack,
  Icon,
  Input,
  Spinner,
  Text,
  Textarea,
  VStack
} from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaBug, FaChevronDown, FaChevronRight, FaCopy, FaEnvelope, FaPlay, FaUsers } from "react-icons/fa";
import { Select as ReactSelect } from "chakra-react-select";
import type { CommonErrorGroup } from "./types";

interface SelectOption {
  label: string;
  value: string;
}

interface RegradeSubmissionsDialogProps {
  assignmentId: number;
  courseId: number;
  errorGroup: CommonErrorGroup;
  onClose: () => void;
  isOpen: boolean;
}

/**
 * Dialog for triggering regrades of submissions affected by a common error.
 * Shows error summary and allows selecting grader SHA and auto-promote options.
 */
export function RegradeSubmissionsDialog({
  assignmentId,
  courseId,
  errorGroup,
  onClose,
  isOpen
}: RegradeSubmissionsDialogProps) {
  const [commitOptions, setCommitOptions] = useState<SelectOption[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<SelectOption | null>(null);
  const [manualSha, setManualSha] = useState<string>("");
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [autoPromote, setAutoPromote] = useState(true);
  const [isRegrading, setIsRegrading] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const [emails, setEmails] = useState<string[]>([]);
  const [emailsLoading, setEmailsLoading] = useState(false);
  const [emailsError, setEmailsError] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);

  // Reset state when dialog opens or errorGroup changes
  useEffect(() => {
    if (isOpen) {
      setManualSha("");
      setSelectedCommit(null);
      setShowEmails(false);
      setEmails([]);
      setEmailsError(null);
      setEmailsLoading(false);
      setCommitsError(null);
    }
  }, [isOpen, errorGroup]);

  // Load recent commits for the autograder
  useEffect(() => {
    let cancelled = false;

    async function loadCommits() {
      if (!isOpen || !assignmentId) return;

      setCommitsLoading(true);
      setCommitsError(null);

      try {
        // Query autograder_commits table for main branch commits
        const { data: commits, error } = await supabase
          .from("autograder_commits")
          .select("sha, message, author, created_at")
          .eq("autograder_id", assignmentId)
          .eq("ref", "refs/heads/main")
          .order("created_at", { ascending: false })
          .limit(50);

        if (error) {
          throw error;
        }

        const formatted = (commits || []).map((commit) => {
          const subject = commit.message?.split("\n")[0] || "No message";
          return {
            value: commit.sha,
            label: `${commit.sha.slice(0, 7)} - ${subject}`
          };
        });

        if (!cancelled) {
          setCommitOptions([{ label: "Latest on main (default)", value: "" }, ...formatted]);
          setSelectedCommit(null);
        }
      } catch (error) {
        if (!cancelled) {
          setCommitsError(error instanceof Error ? error.message : "Failed to load commits");
        }
      } finally {
        if (!cancelled) {
          setCommitsLoading(false);
        }
      }
    }

    void loadCommits();

    return () => {
      cancelled = true;
    };
  }, [isOpen, assignmentId, supabase]);

  // Load student emails when expanded
  useEffect(() => {
    if (!showEmails || !isOpen || errorGroup.affected_submission_ids.length === 0) return;

    let cancelled = false;

    async function fetchEmails() {
      setEmailsLoading(true);
      setEmailsError(null);

      try {
        // Step 1: Get profile_ids from submissions
        const { data: submissions, error: submissionsError } = await supabase
          .from("submissions")
          .select("id, profile_id")
          .in("id", errorGroup.affected_submission_ids);

        if (submissionsError) throw submissionsError;
        if (!submissions || submissions.length === 0) {
          if (!cancelled) setEmails([]);
          return;
        }

        // Get unique profile IDs
        const profileIds = [...new Set(submissions.map((s) => s.profile_id).filter(Boolean))] as string[];

        if (profileIds.length === 0) {
          if (!cancelled) setEmails([]);
          return;
        }

        // Step 2: Get user emails via user_roles
        const { data: userRoles, error: rolesError } = await supabase
          .from("user_roles")
          .select("private_profile_id, users(email)")
          .in("private_profile_id", profileIds);

        if (rolesError) throw rolesError;

        if (!cancelled) {
          // Extract unique emails
          const emailSet = new Set<string>();
          userRoles?.forEach((role) => {
            const users = role.users as unknown as { email: string } | null;
            if (users?.email) {
              emailSet.add(users.email);
            }
          });
          setEmails(Array.from(emailSet).sort());
        }
      } catch (err) {
        if (!cancelled) {
          setEmailsError(err instanceof Error ? err.message : "Failed to fetch emails");
        }
      } finally {
        if (!cancelled) {
          setEmailsLoading(false);
        }
      }
    }

    void fetchEmails();

    return () => {
      cancelled = true;
    };
  }, [showEmails, isOpen, errorGroup.affected_submission_ids, supabase]);

  // Copy emails to clipboard
  const handleCopyEmails = useCallback(async () => {
    if (emails.length === 0) return;

    try {
      await navigator.clipboard.writeText(emails.join(", "));
      toaster.success({
        title: "Copied!",
        description: `${emails.length} email${emails.length !== 1 ? "s" : ""} copied to clipboard`
      });
    } catch {
      toaster.error({
        title: "Failed to copy",
        description: "Could not copy emails to clipboard"
      });
    }
  }, [emails]);

  // Handle regrade action
  const handleRegrade = useCallback(async () => {
    if (errorGroup.affected_submission_ids.length === 0) {
      toaster.error({
        title: "Error",
        description: "No submissions to regrade"
      });
      return;
    }

    setIsRegrading(true);

    try {
      const graderSha = manualSha.trim() || selectedCommit?.value || undefined;

      await rerunGrader(
        {
          submission_ids: errorGroup.affected_submission_ids,
          class_id: courseId,
          grader_sha: graderSha,
          auto_promote: autoPromote
        },
        supabase
      );

      toaster.success({
        title: "Regrading started",
        description: `Queued ${errorGroup.affected_submission_ids.length} submissions for regrading. Check the Workflow Runs page for status.`
      });

      onClose();
    } catch (error) {
      toaster.error({
        title: "Error regrading",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setIsRegrading(false);
    }
  }, [errorGroup.affected_submission_ids, courseId, manualSha, selectedCommit, autoPromote, supabase, onClose]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={({ open }) => !open && onClose()} size="xl">
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>
              <HStack>
                <Icon as={FaPlay} />
                <Text>Regrade Affected Submissions</Text>
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
                      <Icon as={FaBug} color="red.500" />
                      <Badge colorPalette="red">{errorGroup.test_name}</Badge>
                      {errorGroup.test_part && <Badge colorPalette="gray">{errorGroup.test_part}</Badge>}
                    </HStack>
                    <Text fontSize="sm" color="fg.muted" fontFamily="mono" truncate maxW="100%">
                      {errorGroup.error_signature}
                    </Text>
                    <HStack>
                      <Icon as={FaUsers} color="purple.500" />
                      <Badge colorPalette="purple" size="lg">
                        {errorGroup.affected_submission_ids.length} submissions will be regraded
                      </Badge>
                    </HStack>
                  </VStack>
                </Card.Body>
              </Card.Root>

              {/* Affected Student Emails */}
              <Box>
                <Button size="sm" variant="outline" onClick={() => setShowEmails(!showEmails)} mb={showEmails ? 2 : 0}>
                  <Icon as={showEmails ? FaChevronDown : FaChevronRight} mr={2} />
                  <Icon as={FaEnvelope} mr={2} />
                  {showEmails ? "Hide" : "Show"} Affected Student Emails
                </Button>
                <Collapsible.Root open={showEmails}>
                  <Collapsible.Content>
                    <Box p={3} bg="bg.muted" borderRadius="md" borderWidth="1px" borderColor="border.muted">
                      {emailsLoading ? (
                        <HStack justify="center" p={2}>
                          <Spinner size="sm" />
                          <Text fontSize="sm" color="fg.muted">
                            Loading emails...
                          </Text>
                        </HStack>
                      ) : emailsError ? (
                        <Text fontSize="sm" color="fg.error">
                          {emailsError}
                        </Text>
                      ) : emails.length === 0 ? (
                        <Text fontSize="sm" color="fg.muted">
                          No emails found for affected students
                        </Text>
                      ) : (
                        <VStack align="stretch" gap={2}>
                          <HStack justify="space-between">
                            <Text fontSize="sm" fontWeight="medium">
                              {emails.length} student email{emails.length !== 1 ? "s" : ""}
                            </Text>
                            <Button size="xs" variant="outline" onClick={handleCopyEmails}>
                              <Icon as={FaCopy} mr={1} />
                              Copy All
                            </Button>
                          </HStack>
                          <Textarea
                            value={emails.join(", ")}
                            readOnly
                            fontSize="xs"
                            fontFamily="mono"
                            rows={Math.min(4, Math.ceil(emails.length / 2))}
                            resize="vertical"
                            bg="bg.subtle"
                            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                          />
                        </VStack>
                      )}
                    </Box>
                  </Collapsible.Content>
                </Collapsible.Root>
              </Box>

              {/* Grader SHA Selection */}
              <Box>
                <Text fontWeight="semibold" mb={3}>
                  Autograder Version
                </Text>
                <VStack align="stretch" gap={4}>
                  <Box>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      Select a commit from main branch
                    </Text>
                    <ReactSelect
                      name="grader_sha"
                      options={commitOptions}
                      placeholder="Latest on main (default)"
                      isLoading={commitsLoading}
                      value={selectedCommit}
                      onChange={(selected) => {
                        setSelectedCommit(selected as SelectOption | null);
                        if (selected) {
                          setManualSha("");
                        }
                      }}
                      chakraStyles={{
                        container: (provided) => ({
                          ...provided,
                          width: "100%"
                        }),
                        dropdownIndicator: (provided) => ({
                          ...provided,
                          bg: "transparent",
                          px: 2,
                          cursor: "pointer"
                        }),
                        indicatorSeparator: (provided) => ({
                          ...provided,
                          display: "none"
                        })
                      }}
                    />
                    {commitsError && (
                      <Text fontSize="sm" color="fg.error" mt={2}>
                        {commitsError}
                      </Text>
                    )}
                  </Box>

                  <Box>
                    <Text fontSize="sm" color="fg.muted" mb={2}>
                      Or enter a custom SHA
                    </Text>
                    <Input
                      placeholder="Enter any valid SHA (e.g., abc1234)"
                      value={manualSha}
                      onChange={(e) => {
                        setManualSha(e.target.value);
                        if (e.target.value) {
                          setSelectedCommit(null);
                        }
                      }}
                    />
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      You can use any valid SHA from the solution repository
                    </Text>
                  </Box>
                </VStack>
              </Box>

              {/* Auto-promote Option */}
              <Box>
                <Checkbox.Root
                  checked={autoPromote}
                  onCheckedChange={(checked) => setAutoPromote(Boolean(checked.checked))}
                >
                  <Checkbox.HiddenInput />
                  <HStack>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Label>Auto-promote new result to official</Checkbox.Label>
                  </HStack>
                </Checkbox.Root>
                <Text fontSize="xs" color="fg.muted" mt={1} ml={6}>
                  If disabled, new scores will appear as &quot;What-if&quot; results and can be promoted manually.
                </Text>
              </Box>

              {/* Warning */}
              <Box p={4} bg="yellow.50" borderRadius="md" _dark={{ bg: "yellow.900" }}>
                <Text fontSize="sm" color="yellow.700" _dark={{ color: "yellow.200" }}>
                  This will queue {errorGroup.affected_submission_ids.length} submissions for regrading. The process
                  runs asynchronously and may take several minutes depending on the number of submissions.
                </Text>
              </Box>
            </VStack>
          </Dialog.Body>

          <Dialog.Footer>
            <HStack justify="flex-end" gap={3}>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorPalette="green"
                onClick={handleRegrade}
                loading={isRegrading}
                disabled={errorGroup.affected_submission_ids.length === 0}
              >
                <Icon as={FaPlay} mr={2} />
                Regrade {errorGroup.affected_submission_ids.length} Submissions
              </Button>
            </HStack>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
