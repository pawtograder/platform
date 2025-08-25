"use client";
import { useCallback, useState, createContext, useContext, ReactNode } from "react";
import { Input, VStack, Text, Dialog, Portal, Box, Icon } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useForm, SubmitHandler } from "react-hook-form";
import { parse } from "csv-parse/browser/esm/sync";
import { useParams } from "next/navigation";
import { useInvalidate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import { enrollmentAdd, invitationCreate } from "@/lib/edgeFunctions";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { FaFileImport } from "react-icons/fa";
type AppRole = Database["public"]["Enums"]["app_role"];
const allowedRoles: ReadonlyArray<AppRole> = ["instructor", "grader", "student"];

type CSVRecord = {
  email?: string;
  name: string;
  role?: string;
  sis_id?: string;
};

type FormValues = {
  csvFile: FileList;
};

// Context for managing SIS user mapping
interface SISUserContextType {
  sisUserMap: Map<number, string>;
  setSisUserMap: (map: Map<number, string>) => void;
  clearSisUserMap: () => void;
}

const SISUserContext = createContext<SISUserContextType | undefined>(undefined);

const SISUserProvider = ({ children }: { children: ReactNode }) => {
  const [sisUserMap, setSisUserMapState] = useState<Map<number, string>>(new Map());

  const setSisUserMap = useCallback((map: Map<number, string>) => {
    setSisUserMapState(map);
  }, []);

  const clearSisUserMap = useCallback(() => {
    setSisUserMapState(new Map());
  }, []);

  return (
    <SISUserContext.Provider value={{ sisUserMap, setSisUserMap, clearSisUserMap }}>{children}</SISUserContext.Provider>
  );
};

const useSISUserContext = () => {
  const context = useContext(SISUserContext);
  if (context === undefined) {
    throw new Error("useSISUserContext must be used within a SISUserProvider");
  }
  return context;
};

const ImportStudentsCSVModalContent = () => {
  const { course_id } = useParams<{ course_id: string }>();
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmingImport, setIsConfirmingImport] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [usersToPreviewAdd, setUsersToPreviewAdd] = useState<
    Array<{ email?: string; name: string; role: AppRole; sis_id?: number }>
  >([]);
  const [notifyOnAdd, setNotifyOnAdd] = useState<boolean>(false);
  const [usersToPreviewIgnore, setUsersToPreviewIgnore] = useState<
    Array<{ email?: string; name: string; role: AppRole; sis_id?: number }>
  >([]);
  const [importMode, setImportMode] = useState<"email" | "sis_id" | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const onClose = useCallback(() => setIsOpen(false), []);

  const invalidate = useInvalidate();
  const supabase = createClient();
  const { sisUserMap, setSisUserMap, clearSisUserMap } = useSISUserContext();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset
  } = useForm<FormValues>();

  const handlePreviewBack = () => {
    setIsPreviewMode(false);
    setUsersToPreviewAdd([]);
    setUsersToPreviewIgnore([]);
    setImportMode(null);
    clearSisUserMap();
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

            return {
              email: record.email?.trim(),
              name: record.name?.trim(),
              role: role,
              sis_id: sisIdAsNumber
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

        // Fetch existing users and create preview lists
        let existingUserIdentifiers: (string | number)[] = [];

        if (detectedMode === "email") {
          const { data: existingEnrollmentsData, error: existingEnrollmentsError } = await supabase
            .from("user_roles")
            .select("users ( email )")
            .eq("class_id", Number(course_id))
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

          existingUserIdentifiers =
            (existingEnrollmentsData?.map((er) => er.users?.email).filter((email) => !!email) as string[]) || [];
        } else {
          // SIS ID mode - check for existing users and their enrollment status
          const sisIds = processedUsers.map((user) => user.sis_id).filter((id): id is number => !!id);

          // First, get all users with these SIS IDs
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

          // Check which existing users are already enrolled in this class
          const existingUserIds = Array.from(existingUserMap.values());
          const { data: existingEnrollments, error: enrollmentError } = await supabase
            .from("user_roles")
            .select("user_id")
            .eq("class_id", Number(course_id))
            .in("user_id", existingUserIds)
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

          // Check for pending invitations for existing users
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

          // Build list of SIS IDs that should be ignored (already enrolled or have pending invitations)
          existingUserIdentifiers = [];
          for (const [sisId, userId] of existingUserMap) {
            if (enrolledUserIds.has(userId) || pendingInvitationSisIds.has(sisId)) {
              existingUserIdentifiers.push(sisId);
            }
          }

          // Store the user mapping for later use in enrollment
          setSisUserMap(existingUserMap);
        }

        const toAdd: Array<{ email?: string; name: string; role: AppRole; sis_id?: number }> = [];
        const toIgnore: Array<{ email?: string; name: string; role: AppRole; sis_id?: number }> = [];

        processedUsers.forEach((user) => {
          const identifier = detectedMode === "sis_id" ? user.sis_id : user.email;
          if (identifier && existingUserIdentifiers.includes(identifier)) {
            toIgnore.push(user);
          } else {
            toAdd.push(user);
          }
        });

        setUsersToPreviewAdd(toAdd);
        setUsersToPreviewIgnore(toIgnore);
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
    if (usersToPreviewAdd.length === 0) {
      toaster.create({
        title: "No new users to import",
        description: "There are no new users to enroll.",
        type: "info"
      });
      setIsPreviewMode(false);
      reset();
      onClose(); // Or just go back to preview selection? For now, close.
      return;
    }

    setIsConfirmingImport(true);
    try {
      const results = await Promise.allSettled(
        usersToPreviewAdd.map(async (user) => {
          try {
            if (importMode === "sis_id") {
              const existingUserId = sisUserMap.get(user.sis_id!);

              if (existingUserId) {
                // User exists in system but not enrolled in class - use RPC function to create enrollment
                const { error: enrollError } = await supabase.rpc("create_user_role_for_existing_user", {
                  p_user_id: existingUserId,
                  p_class_id: Number(course_id),
                  p_role: user.role as Database["public"]["Enums"]["app_role"],
                  p_name: user.name,
                  p_sis_id: user.sis_id
                });

                if (enrollError) {
                  console.error("RPC Error details:", enrollError);
                  toaster.create({
                    title: "Enrollment Error",
                    description: `Failed to enroll ${user.name} (SIS ID: ${user.sis_id}): ${enrollError.message}`,
                    type: "error",
                    duration: 8000
                  });
                  throw new Error(`RPC Error for ${user.name}: ${enrollError.message}`);
                }
              } else {
                // User doesn't exist in system - create invitation
                await invitationCreate(
                  {
                    courseId: Number(course_id),
                    invitations: [
                      {
                        sis_user_id: user.sis_id!.toString(),
                        role: user.role as "instructor" | "grader" | "student",
                        name: user.name
                      }
                    ]
                  },
                  supabase
                );
              }
              return { identifier: user.sis_id, name: user.name, status: "fulfilled" };
            } else {
              // Use enrollment for email imports
              await enrollmentAdd(
                {
                  courseId: Number(course_id),
                  email: user.email!,
                  name: user.name!,
                  role: user.role,
                  notify: notifyOnAdd
                },
                supabase
              );
              return { identifier: user.email, name: user.name, status: "fulfilled" };
            }
          } catch (error) {
            return {
              identifier: importMode === "sis_id" ? user.sis_id : user.email,
              name: user.name,
              status: "rejected",
              reason: error instanceof Error ? error.message : "Unknown error"
            };
          }
        })
      );

      const successfulEnrollments = results.filter((r) => r.status === "fulfilled").length;
      const failedEnrollments = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

      if (successfulEnrollments > 0) {
        let description = `Successfully enrolled ${successfulEnrollments} out of ${usersToPreviewAdd.length} selected new users.`;
        if (failedEnrollments.length > 0) {
          description += ` ${failedEnrollments.length} failed.`;
          const firstFewFailedReasons = failedEnrollments
            .slice(0, 3)
            .map((f) => `(${f.reason?.toString().substring(0, 100) || "Unknown reason"})`)
            .join(", ");
          description += ` Reasons: ${firstFewFailedReasons}`;
          if (failedEnrollments.length > 3) description += ` and ${failedEnrollments.length - 3} more...`;
        }
        toaster.create({
          title: "Import Confirmed",
          description: description,
          type: successfulEnrollments === usersToPreviewAdd.length ? "success" : "warning",
          duration: failedEnrollments.length > 0 ? 10000 : 5000 // Longer duration if there are errors
        });
        invalidate({ resource: "user_roles", invalidates: ["all"] });
        invalidate({ resource: "profiles", invalidates: ["all"] });
      } else {
        if (usersToPreviewAdd.length > 0) {
          // All attempted users failed
          let description = `Failed to enroll all ${failedEnrollments.length} selected new email(s).`;
          const firstFewFailedReasons = failedEnrollments
            .slice(0, 3)
            .map((f) => `(${f.reason?.toString().substring(0, 100) || "Unknown reason"})`)
            .join(", ");
          description += ` Reasons: ${firstFewFailedReasons}`;
          if (failedEnrollments.length > 3) description += ` and ${failedEnrollments.length - 3} more...`;

          toaster.create({
            title: "Import Failed",
            description: description,
            type: "error",
            duration: 10000 // Longer duration for detailed errors
          });
        }
      }
    } catch (error) {
      toaster.create({
        title: "Error During Final Import",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
        type: "error"
      });
    } finally {
      setIsConfirmingImport(false);
      clearSisUserMap();
      reset();
      onClose();
    }
  };

  const handleClose = () => {
    reset();
    setIsPreviewMode(false);
    setUsersToPreviewAdd([]);
    setUsersToPreviewIgnore([]);
    setImportMode(null);
    clearSisUserMap();
    onClose();
  };

  return (
    <Dialog.Root
      aria-label="Import Roster from CSV"
      open={isOpen}
      onOpenChange={(details) => !details.open && handleClose()}
    >
      <Dialog.Trigger asChild>
        <Button onClick={() => setIsOpen(true)}>
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
                  {usersToPreviewAdd.length > 0 && (
                    <Box>
                      <Text fontWeight="bold" mb={2}>
                        Users to be added ({usersToPreviewAdd.length}):
                      </Text>
                      {importMode === "email" && (
                        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <input
                            type="checkbox"
                            checked={notifyOnAdd}
                            onChange={(e) => setNotifyOnAdd(e.target.checked)}
                          />
                          Notify users they were added to this course
                        </label>
                      )}
                      <VStack
                        as="ul"
                        listStyleType="none"
                        gap={1}
                        maxHeight="150px"
                        overflowY="auto"
                        borderWidth="1px"
                        borderRadius="md"
                        p={2}
                      >
                        {usersToPreviewAdd.map(
                          (user: { email?: string; name: string; role: AppRole; sis_id?: number }) => {
                            const identifier = importMode === "sis_id" ? `SIS ID: ${user.sis_id}` : user.email;
                            const key = importMode === "sis_id" ? `sis_${user.sis_id}` : user.email!;

                            let actionText = "";
                            let actionColor = "blue.600";

                            if (importMode === "sis_id") {
                              const existingUserId = sisUserMap.get(user.sis_id!);
                              if (existingUserId) {
                                actionText = " → Will be enrolled directly";
                                actionColor = "green.600";
                              } else {
                                actionText = " → Will receive invitation";
                                actionColor = "blue.600";
                              }
                            } else {
                              actionText = " → Will be enrolled directly";
                              actionColor = "green.600";
                            }

                            return (
                              <Text as="li" key={key}>
                                {user.name} ({identifier}) - Role: {user.role}
                                <Text as="span" color={actionColor} fontWeight="medium">
                                  {actionText}
                                </Text>
                              </Text>
                            );
                          }
                        )}
                      </VStack>
                    </Box>
                  )}
                  {usersToPreviewIgnore.length > 0 && (
                    <Box>
                      <Text fontWeight="bold" mb={2}>
                        Users already enrolled or invited (will be ignored - {usersToPreviewIgnore.length}):
                      </Text>
                      <VStack
                        as="ul"
                        listStyleType="none"
                        gap={1}
                        maxHeight="150px"
                        overflowY="auto"
                        borderWidth="1px"
                        borderRadius="md"
                        p={2}
                      >
                        {usersToPreviewIgnore.map(
                          (user: { email?: string; name: string; role: AppRole; sis_id?: number }) => {
                            const identifier = importMode === "sis_id" ? `SIS ID: ${user.sis_id}` : user.email;
                            const key = importMode === "sis_id" ? `sis_ignore_${user.sis_id}` : `ignore_${user.email}`;
                            return (
                              <Text as="li" key={key}>
                                {user.name} ({identifier}) - Role: {user.role}
                              </Text>
                            );
                          }
                        )}
                      </VStack>
                    </Box>
                  )}
                  {usersToPreviewAdd.length === 0 && usersToPreviewIgnore.length > 0 && (
                    <Text>All users in the CSV are already enrolled in this course or have pending invitations.</Text>
                  )}
                  {usersToPreviewAdd.length === 0 && usersToPreviewIgnore.length === 0 && (
                    <Text>No users found in the CSV to process after filtering.</Text> // Should be caught earlier, but as a fallback
                  )}
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
                          <Text fontSize="sm" color="fg.subtle">
                            <strong>Option 1 - Email Import:</strong> Include columns &apos;email&apos;,
                            &apos;name&apos;, and optionally &apos;role&apos;. Users will be directly enrolled in the
                            course.
                          </Text>
                          <Text fontSize="sm" color="fg.subtle" mt={1}>
                            <strong>Option 2 - SIS ID Import (Recommended):</strong> Include columns &apos;sis_id&apos;,
                            &apos;name&apos;, and optionally &apos;role&apos;. Users will receive invitations to join
                            the course via their institutional accounts.
                          </Text>
                          <Text fontSize="sm" color="orange.600" mt={1} fontWeight="medium">
                            ⚠️ Do not include both &apos;email&apos; and &apos;sis_id&apos; columns in the same CSV.
                          </Text>
                        </Box>
                        <Text fontSize="sm" color="fg.subtle">
                          If &apos;role&apos; is not provided or invalid, it defaults to &apos;student&apos;. Valid
                          roles: student, grader, instructor.
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
                        • <strong>Email Import:</strong> Users are immediately enrolled. Existing users are ignored.
                      </Text>
                      <Text fontSize="sm" color="gray.500">
                        • <strong>SIS ID Import:</strong> Users already in the system are enrolled directly. New users
                        receive invitations. Users already enrolled in this class are ignored.
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
                    disabled={isConfirmingImport || usersToPreviewAdd.length === 0}
                  >
                    Confirm Import ({usersToPreviewAdd.length})
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

// Wrapper component with provider
const ImportStudentsCSVModal = () => {
  return (
    <SISUserProvider>
      <ImportStudentsCSVModalContent />
    </SISUserProvider>
  );
};

export default ImportStudentsCSVModal;
