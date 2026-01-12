"use client";
import { useCallback, useState } from "react";
import { Input, VStack, Text, Dialog, Portal, Box, Icon } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useForm, SubmitHandler } from "react-hook-form";
import { parse } from "csv-parse/browser/esm/sync";
import { useParams } from "next/navigation";
import { useInvalidate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { FaFileImport } from "react-icons/fa";
type AppRole = Database["public"]["Enums"]["app_role"];
const allowedRoles: ReadonlyArray<AppRole> = ["instructor", "grader", "student"];

function parseOptionalBoolean(value?: string): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (["true", "t", "1", "yes", "y"].includes(v)) return true;
  if (["false", "f", "0", "no", "n"].includes(v)) return false;
  return undefined;
}

type CSVRecord = {
  email?: string;
  name: string;
  role?: string;
  sis_id?: string;
  sis_sync_opt_out?: string;
};

type FormValues = {
  csvFile: FileList;
};

type PreviewUser = {
  email?: string;
  name: string;
  role: AppRole;
  sis_id?: number;
  sis_sync_opt_out?: boolean;
  action: "enroll" | "invite" | "reactivate" | "skip_pending_invitation";
};

const ImportStudentsCSVModal = () => {
  const { course_id } = useParams<{ course_id: string }>();
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmingImport, setIsConfirmingImport] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [previewUsers, setPreviewUsers] = useState<PreviewUser[]>([]);
  const [notifyOnAdd, setNotifyOnAdd] = useState<boolean>(false);
  const [importMode, setImportMode] = useState<"email" | "sis_id" | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const onClose = useCallback(() => setIsOpen(false), []);

  const invalidate = useInvalidate();
  const supabase = createClient();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset
  } = useForm<FormValues>();

  const handlePreviewBack = () => {
    setIsPreviewMode(false);
    setPreviewUsers([]);
    setImportMode(null);
    reset();
  };

  const processImportPreview: SubmitHandler<FormValues> = async (data) => {
    const file = data.csvFile[0];
    if (!file) {
      toaster.create({ title: "No file selected", description: "Please select a CSV file to import.", type: "error" });
      return;
    }
    if (!course_id) {
      toaster.create({ title: "Error", description: "Course ID is missing.", type: "error" });
      return;
    }

    setIsLoading(true);
    const reader = new FileReader();

    reader.onload = async (e) => {
      const csvText = e.target?.result as string;
      try {
        const records: CSVRecord[] = parse(csvText, {
          columns: true,
          skip_empty_lines: true
        });

        if (!records || records.length === 0) {
          toaster.create({
            title: "Empty CSV",
            description: "The CSV file is empty or incorrectly formatted.",
            type: "warning"
          });
          setIsLoading(false);
          return;
        }

        // Detect import mode based on CSV columns
        const hasEmailColumn = records.some((record) => record.email?.trim());
        const hasSisIdColumn = records.some((record) => record.sis_id?.trim());

        let detectedMode: "email" | "sis_id";
        if (hasSisIdColumn && hasEmailColumn) {
          // Both columns present - throw error to avoid confusion
          toaster.create({
            title: "Invalid CSV Format",
            description:
              "CSV cannot contain both 'email' and 'sis_id' columns. Please use either email-based import OR SIS ID-based import, not both.",
            type: "error"
          });
          setIsLoading(false);
          return;
        } else if (hasSisIdColumn && !hasEmailColumn) {
          detectedMode = "sis_id";
        } else if (hasEmailColumn && !hasSisIdColumn) {
          detectedMode = "email";
        } else {
          toaster.create({
            title: "Invalid CSV Format",
            description: "CSV must contain either 'email' or 'sis_id' column.",
            type: "error"
          });
          setIsLoading(false);
          return;
        }

        setImportMode(detectedMode);

        const processedUsers = records
          .map((record: CSVRecord) => {
            const csvRole = record.role?.trim().toLowerCase();
            let role: AppRole = "student";
            if (csvRole && (allowedRoles as ReadonlyArray<string>).includes(csvRole)) {
              role = csvRole as AppRole;
            } else if (csvRole) {
              const identifier = detectedMode === "sis_id" ? record.sis_id : record.email;
              toaster.create({
                title: "Invalid Role",
                description: `Invalid role "${record.role}" provided for ${identifier}. Defaulting to "student".`,
                type: "warning"
              });
            }

            const rawSisId = record.sis_id?.trim();
            const sisIdAsNumber =
              rawSisId && rawSisId !== "" && !isNaN(parseInt(rawSisId, 10)) ? parseInt(rawSisId, 10) : undefined;
            const sis_sync_opt_out = parseOptionalBoolean(record.sis_sync_opt_out);

            return {
              email: record.email?.trim(),
              name: record.name?.trim(),
              role: role,
              sis_id: sisIdAsNumber,
              sis_sync_opt_out
            };
          })
          .filter((user) => {
            if (detectedMode === "sis_id") {
              return !!user.sis_id && !!user.name;
            } else {
              return !!user.email && !!user.name;
            }
          });

        if (processedUsers.length === 0) {
          toaster.create({
            title: "No Valid Users Found",
            description: "No users with email and name found, or CSV format is incorrect.",
            type: "warning"
          });
          setIsLoading(false);
          return;
        }

        // Determine action for each user based on their current state
        const usersWithActions: PreviewUser[] = [];

        if (detectedMode === "email") {
          // Email mode: check existing enrollments
          const emails = processedUsers.map((u) => u.email).filter((e): e is string => !!e);

          const { data: existingEnrollmentsData, error: existingEnrollmentsError } = await supabase
            .from("user_roles")
            .select("users!inner( email )")
            .eq("class_id", Number(course_id))
            .in("users.email", emails)
            .limit(1000);

          if (existingEnrollmentsError) {
            toaster.create({
              title: "Error fetching enrollments",
              description: existingEnrollmentsError.message,
              type: "error"
            });
            setIsLoading(false);
            return;
          }

          const enrolledEmails = new Set(
            (existingEnrollmentsData || []).map((er) => er.users?.email?.toLowerCase()).filter((e): e is string => !!e)
          );

          processedUsers.forEach((user) => {
            const emailLower = user.email?.toLowerCase();
            if (emailLower && enrolledEmails.has(emailLower)) {
              usersWithActions.push({ ...user, name: user.name!, action: "reactivate" });
            } else {
              usersWithActions.push({ ...user, name: user.name!, action: "enroll" });
            }
          });
        } else {
          // SIS ID mode: check users, enrollments, and invitations
          const sisIds = processedUsers.map((user) => user.sis_id).filter((id): id is number => !!id);

          // Get existing users with these SIS IDs
          const { data: existingUsers, error: existingUsersError } = await supabase
            .from("users")
            .select("user_id, sis_user_id")
            .in("sis_user_id", sisIds)
            .limit(1000);

          if (existingUsersError) {
            toaster.create({
              title: "Error checking existing users",
              description: existingUsersError.message,
              type: "error"
            });
            setIsLoading(false);
            return;
          }

          const existingUserMap = new Map(
            (existingUsers || [])
              .filter((user) => user.sis_user_id !== null)
              .map((user) => [user.sis_user_id!, user.user_id])
          );

          // Check which existing users are already enrolled
          const existingUserIds = Array.from(existingUserMap.values());
          const { data: existingEnrollments, error: enrollmentError } = await supabase
            .from("user_roles")
            .select("user_id")
            .eq("class_id", Number(course_id))
            .in("user_id", existingUserIds.length > 0 ? existingUserIds : ["00000000-0000-0000-0000-000000000000"])
            .limit(1000);

          if (enrollmentError) {
            toaster.create({
              title: "Error checking existing enrollments",
              description: enrollmentError.message,
              type: "error"
            });
            setIsLoading(false);
            return;
          }

          const enrolledUserIds = new Set((existingEnrollments || []).map((e) => e.user_id));

          // Check for pending invitations
          const { data: pendingInvitations, error: invitationError } = await supabase
            .from("invitations")
            .select("sis_user_id")
            .eq("class_id", Number(course_id))
            .eq("status", "pending")
            .in("sis_user_id", sisIds)
            .limit(1000);

          if (invitationError) {
            toaster.create({
              title: "Error checking pending invitations",
              description: invitationError.message,
              type: "error"
            });
            setIsLoading(false);
            return;
          }

          const pendingInvitationSisIds = new Set((pendingInvitations || []).map((inv) => inv.sis_user_id));

          // Categorize each user
          processedUsers.forEach((user) => {
            const sisId = user.sis_id!;
            const existingUserId = existingUserMap.get(sisId);

            if (existingUserId && enrolledUserIds.has(existingUserId)) {
              // Already enrolled → reactivate
              usersWithActions.push({ ...user, name: user.name!, action: "reactivate" });
            } else if (pendingInvitationSisIds.has(sisId)) {
              // Has pending invitation → skip
              usersWithActions.push({ ...user, name: user.name!, action: "skip_pending_invitation" });
            } else if (existingUserId) {
              // User exists but not enrolled → enroll directly
              usersWithActions.push({ ...user, name: user.name!, action: "enroll" });
            } else {
              // User doesn't exist → create invitation
              usersWithActions.push({ ...user, name: user.name!, action: "invite" });
            }
          });
        }

        setPreviewUsers(usersWithActions);
        setIsPreviewMode(true);
      } catch (error) {
        toaster.create({
          title: "Error processing CSV for preview",
          description: error instanceof Error ? error.message : "Could not process the CSV file.",
          type: "error"
        });
      } finally {
        setIsLoading(false);
      }
    };

    reader.onerror = () => {
      toaster.create({ title: "File Read Error", description: "Could not read the selected file.", type: "error" });
      setIsLoading(false);
    };

    reader.readAsText(file);
  };

  const handleConfirmImport = async () => {
    // Filter to only users that will be processed (not skip_pending_invitation)
    const usersToProcess = previewUsers.filter((u) => u.action !== "skip_pending_invitation");

    if (usersToProcess.length === 0) {
      toaster.create({
        title: "No users to import",
        description: "All users already have pending invitations.",
        type: "info"
      });
      setIsPreviewMode(false);
      reset();
      onClose();
      return;
    }

    setIsConfirmingImport(true);
    try {
      // Prepare enrollment data for RPC
      const enrollmentData = usersToProcess.map((user) => ({
        email: user.email,
        name: user.name,
        role: user.role,
        sis_id: user.sis_id,
        sis_sync_opt_out: user.sis_sync_opt_out ?? false
      }));

      // Call the bulk import RPC
      // Note: Type assertion needed until migration is applied and types are regenerated
      type BulkImportResult = {
        enrolled_directly: number;
        invitations_created: number;
        reactivated: number;
        errors: Array<{ identifier: string | number; error: string }>;
      };

      const { data: result, error: rpcError } = (await supabase.rpc(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "bulk_csv_import_enrollment" as any,
        {
          p_class_id: Number(course_id),
          p_import_mode: importMode,
          p_enrollment_data: enrollmentData,
          p_notify: notifyOnAdd
        }
      )) as { data: BulkImportResult | null; error: { message: string } | null };

      if (rpcError) {
        toaster.create({
          title: "Import Error",
          description: rpcError.message,
          type: "error",
          duration: 10000
        });
        return;
      }

      const typedResult = result as BulkImportResult;

      const totalSuccess = typedResult.enrolled_directly + typedResult.invitations_created + typedResult.reactivated;
      const totalErrors = typedResult.errors?.length || 0;

      if (totalSuccess > 0) {
        const parts: string[] = [];
        if (typedResult.enrolled_directly > 0) {
          parts.push(`${typedResult.enrolled_directly} enrolled`);
        }
        if (typedResult.invitations_created > 0) {
          parts.push(`${typedResult.invitations_created} invitations created`);
        }
        if (typedResult.reactivated > 0) {
          parts.push(`${typedResult.reactivated} reactivated`);
        }

        let description = parts.join(", ") + ".";

        if (totalErrors > 0) {
          const errorSummary = typedResult.errors
            .slice(0, 3)
            .map((e) => `${e.identifier}: ${e.error.substring(0, 50)}`)
            .join("; ");
          description += ` ${totalErrors} failed: ${errorSummary}`;
          if (totalErrors > 3) description += ` and ${totalErrors - 3} more...`;
        }

        toaster.create({
          title: "Import Complete",
          description,
          type: totalErrors === 0 ? "success" : "warning",
          duration: totalErrors > 0 ? 10000 : 5000
        });

        invalidate({ resource: "user_roles", invalidates: ["all"] });
        invalidate({ resource: "profiles", invalidates: ["all"] });
        invalidate({ resource: "invitations", invalidates: ["all"] });
      } else if (totalErrors > 0) {
        const errorSummary = typedResult.errors
          .slice(0, 3)
          .map((e) => `${e.identifier}: ${e.error.substring(0, 50)}`)
          .join("; ");
        toaster.create({
          title: "Import Failed",
          description: `All ${totalErrors} users failed: ${errorSummary}`,
          type: "error",
          duration: 10000
        });
      }
    } catch (error) {
      toaster.create({
        title: "Error During Import",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
        type: "error"
      });
    } finally {
      setIsConfirmingImport(false);
      reset();
      onClose();
    }
  };

  const handleClose = () => {
    reset();
    setIsPreviewMode(false);
    setPreviewUsers([]);
    setImportMode(null);
    onClose();
  };

  // Categorize preview users for display
  const usersToEnroll = previewUsers.filter((u) => u.action === "enroll");
  const usersToInvite = previewUsers.filter((u) => u.action === "invite");
  const usersToReactivate = previewUsers.filter((u) => u.action === "reactivate");
  const usersToSkip = previewUsers.filter((u) => u.action === "skip_pending_invitation");
  const usersToProcess = previewUsers.filter((u) => u.action !== "skip_pending_invitation");

  return (
    <Dialog.Root
      aria-label="Import Roster from CSV"
      open={isOpen}
      onOpenChange={(details) => !details.open && handleClose()}
    >
      <Dialog.Trigger asChild>
        <Button onClick={() => setIsOpen(true)} variant="surface">
          <Icon as={FaFileImport} />
          Import from CSV
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={handleSubmit(isPreviewMode ? () => {} : processImportPreview)}>
            <Dialog.Header>
              <Dialog.Title>Import Students from CSV</Dialog.Title>
              <Dialog.CloseTrigger onClick={handleClose} />
            </Dialog.Header>
            <Dialog.Body>
              {isPreviewMode ? (
                <VStack gap={4} align="stretch">
                  {/* Notification option */}
                  {usersToProcess.length > 0 && (
                    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={notifyOnAdd} onChange={(e) => setNotifyOnAdd(e.target.checked)} />
                      Notify users they were added to this course
                    </label>
                  )}

                  {/* Users to be enrolled directly */}
                  {usersToEnroll.length > 0 && (
                    <Box>
                      <Text fontWeight="bold" mb={2} color="green.600">
                        Will be enrolled directly ({usersToEnroll.length}):
                      </Text>
                      <VStack
                        as="ul"
                        listStyleType="none"
                        gap={1}
                        maxHeight="120px"
                        overflowY="auto"
                        borderWidth="1px"
                        borderRadius="md"
                        p={2}
                      >
                        {usersToEnroll.map((user) => {
                          const identifier = importMode === "sis_id" ? `SIS ID: ${user.sis_id}` : user.email;
                          const key = importMode === "sis_id" ? `enroll_${user.sis_id}` : `enroll_${user.email}`;
                          return (
                            <Text as="li" key={key} fontSize="sm">
                              {user.name} ({identifier}) - {user.role}
                            </Text>
                          );
                        })}
                      </VStack>
                    </Box>
                  )}

                  {/* Users to receive invitations (SIS ID mode only) */}
                  {usersToInvite.length > 0 && (
                    <Box>
                      <Text fontWeight="bold" mb={2} color="blue.600">
                        Will receive invitation ({usersToInvite.length}):
                      </Text>
                      <VStack
                        as="ul"
                        listStyleType="none"
                        gap={1}
                        maxHeight="120px"
                        overflowY="auto"
                        borderWidth="1px"
                        borderRadius="md"
                        p={2}
                      >
                        {usersToInvite.map((user) => {
                          const key = `invite_${user.sis_id}`;
                          return (
                            <Text as="li" key={key} fontSize="sm">
                              {user.name} (SIS ID: {user.sis_id}) - {user.role}
                            </Text>
                          );
                        })}
                      </VStack>
                    </Box>
                  )}

                  {/* Users to be reactivated */}
                  {usersToReactivate.length > 0 && (
                    <Box>
                      <Text fontWeight="bold" mb={2} color="orange.600">
                        Already enrolled - will be reactivated ({usersToReactivate.length}):
                      </Text>
                      <Text fontSize="xs" color="fg.subtle" mb={2}>
                        These users are already enrolled. They will be marked as manually managed (exempt from SIS sync)
                        and reactivated if disabled.
                      </Text>
                      <VStack
                        as="ul"
                        listStyleType="none"
                        gap={1}
                        maxHeight="120px"
                        overflowY="auto"
                        borderWidth="1px"
                        borderRadius="md"
                        p={2}
                      >
                        {usersToReactivate.map((user) => {
                          const identifier = importMode === "sis_id" ? `SIS ID: ${user.sis_id}` : user.email;
                          const key =
                            importMode === "sis_id" ? `reactivate_${user.sis_id}` : `reactivate_${user.email}`;
                          return (
                            <Text as="li" key={key} fontSize="sm">
                              {user.name} ({identifier}) - {user.role}
                            </Text>
                          );
                        })}
                      </VStack>
                    </Box>
                  )}

                  {/* Users with pending invitations - will be skipped */}
                  {usersToSkip.length > 0 && (
                    <Box>
                      <Text fontWeight="bold" mb={2} color="gray.500">
                        Already have pending invitation - will be skipped ({usersToSkip.length}):
                      </Text>
                      <VStack
                        as="ul"
                        listStyleType="none"
                        gap={1}
                        maxHeight="100px"
                        overflowY="auto"
                        borderWidth="1px"
                        borderRadius="md"
                        p={2}
                        opacity={0.7}
                      >
                        {usersToSkip.map((user) => {
                          const key = `skip_${user.sis_id}`;
                          return (
                            <Text as="li" key={key} fontSize="sm">
                              {user.name} (SIS ID: {user.sis_id}) - {user.role}
                            </Text>
                          );
                        })}
                      </VStack>
                    </Box>
                  )}

                  {/* No actionable users */}
                  {usersToProcess.length === 0 && usersToSkip.length > 0 && (
                    <Text>All users already have pending invitations.</Text>
                  )}
                  {previewUsers.length === 0 && <Text>No users found in the CSV to process.</Text>}
                </VStack>
              ) : (
                <VStack gap={4}>
                  <Field
                    label="CSV File"
                    errorText={errors.csvFile?.message?.toString()}
                    invalid={!!errors.csvFile}
                    required
                  >
                    <Input
                      id="csv-upload"
                      type="file"
                      accept=".csv"
                      {...register("csvFile", { required: "A CSV file is required" })}
                      p={1.5}
                    />
                    {!errors.csvFile && (
                      <VStack gap={2} align="stretch" mt={2}>
                        <Text fontSize="sm">
                          <strong>CSV Format Options:</strong>
                        </Text>
                        <Box pl={4}>
                          <Text fontSize="sm" color="fg.subtle" mt={1}>
                            <strong>Option 1 - SIS ID Import (Recommended):</strong> Include columns &apos;sis_id&apos;,
                            &apos;name&apos;, and optionally &apos;role&apos;. Users will receive invitations to join
                            the course via their institutional accounts. If they later get added via Banner, the records
                            will automatically be merged.
                          </Text>
                          <Text fontSize="sm" color="fg.subtle">
                            <strong>Option 2 - Email Import:</strong> Include columns &apos;email&apos;,
                            &apos;name&apos;, and optionally &apos;role&apos;. Users will be directly enrolled in the
                            course. For Northeastern users, this ONLY works if you use the user&apos;s initial email
                            address. This is needlessley complicated: many users have multiple @northeastern.edu
                            addresses, and you will need to guess the right one.
                          </Text>
                          <Text fontSize="sm" color="orange.600" mt={1} fontWeight="medium">
                            ⚠️ Do not include both &apos;email&apos; and &apos;sis_id&apos; columns in the same CSV.
                          </Text>
                        </Box>
                        <Text fontSize="sm" color="fg.subtle">
                          If &apos;role&apos; is not provided or invalid, it defaults to &apos;student&apos;. Valid
                          roles: student, grader, instructor.
                        </Text>
                        <Text fontSize="sm" color="fg.subtle">
                          Optional: include a &apos;sis_sync_opt_out&apos; column (true/false) to mark created
                          enrollments as <strong>not</strong> managed by SIS sync.
                        </Text>
                      </VStack>
                    )}
                  </Field>
                  <VStack gap={2} align="stretch">
                    <Text fontSize="sm" color="gray.500">
                      <strong>Import Behavior:</strong>
                    </Text>
                    <Box pl={4}>
                      <Text fontSize="sm" color="gray.500">
                        • <strong>SIS ID Import:</strong> Users already in the system are enrolled directly. New users
                        receive invitations. Users already enrolled in this class are ignored.
                      </Text>
                      <Text fontSize="sm" color="gray.500">
                        • <strong>Email Import:</strong> Users are immediately enrolled. Existing users are ignored.
                      </Text>
                    </Box>
                  </VStack>
                </VStack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              {isPreviewMode ? (
                <>
                  <Button variant="outline" mr={3} onClick={handlePreviewBack} disabled={isConfirmingImport}>
                    Back
                  </Button>
                  <Button
                    colorPalette="green"
                    onClick={handleConfirmImport}
                    loading={isConfirmingImport}
                    disabled={isConfirmingImport || usersToProcess.length === 0}
                  >
                    Confirm Import ({usersToProcess.length})
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    colorPalette="red"
                    mr={3}
                    onClick={handleClose}
                    disabled={isLoading || isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    colorPalette="green"
                    loading={isLoading || isSubmitting}
                    disabled={isLoading || isSubmitting}
                  >
                    Show Import Preview
                  </Button>
                </>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default ImportStudentsCSVModal;
