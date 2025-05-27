"use client";
import { useState } from "react";
import { Input, VStack, Text, Dialog, Portal, Box } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useForm, type SubmitHandler } from "react-hook-form";
import { parse } from "csv-parse/browser/esm/sync";
import { useParams } from "next/navigation";
import { useInvalidate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import { enrollmentAdd } from "@/lib/edgeFunctions";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type AppRole = Database["public"]["Enums"]["app_role"];
const allowedRoles: ReadonlyArray<AppRole> = ["instructor", "grader", "student"];

type CSVRecord = {
  email: string;
  name: string;
  role?: string;
  canvas_id?: string;
};

type FormValues = {
  csvFile: FileList;
};

type ImportStudentsCSVModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

const ImportStudentsCSVModal = ({ isOpen, onClose }: ImportStudentsCSVModalProps) => {
  const { course_id } = useParams<{ course_id: string }>();
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmingImport, setIsConfirmingImport] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [usersToPreviewAdd, setUsersToPreviewAdd] = useState<
    Array<{ email: string; name: string; role: AppRole; canvas_id?: number }>
  >([]);
  const [usersToPreviewIgnore, setUsersToPreviewIgnore] = useState<
    Array<{ email: string; name: string; role: AppRole; canvas_id?: number }>
  >([]);

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
    setUsersToPreviewAdd([]);
    setUsersToPreviewIgnore([]);
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

        const processedUsers = records
          .map((record: CSVRecord) => {
            const csvRole = record.role?.trim().toLowerCase();
            let role: AppRole = "student";
            if (csvRole && (allowedRoles as ReadonlyArray<string>).includes(csvRole)) {
              role = csvRole as AppRole;
            } else if (csvRole) {
              toaster.create({
                title: "Invalid Role",
                description: `Invalid role "${record.role}" provided for ${record.email}. Defaulting to "student".`,
                type: "warning"
              });
            }
            const rawCanvasId = record.canvas_id?.trim();
            const canvasIdAsNumber =
              rawCanvasId && rawCanvasId !== "" && !isNaN(parseInt(rawCanvasId, 10))
                ? parseInt(rawCanvasId, 10)
                : undefined;
            return {
              email: record.email?.trim(),
              name: record.name?.trim(),
              role: role,
              canvas_id: canvasIdAsNumber
            };
          })
          .filter(
            (user): user is { email: string; name: string; role: AppRole; canvas_id: number | undefined } =>
              !!user.email && !!user.name
          );

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
        const { data: existingEnrollmentsData, error: existingEnrollmentsError } = await supabase
          .from("user_roles")
          .select("users ( email )")
          .eq("class_id", Number(course_id));

        if (existingEnrollmentsError) {
          toaster.create({
            title: "Error fetching enrollments",
            description: existingEnrollmentsError.message,
            type: "error"
          });
          setIsLoading(false);
          return;
        }

        const existingUserEmails =
          (existingEnrollmentsData?.map((er) => er.users?.email).filter((email) => !!email) as string[]) || [];

        const toAdd: Array<{ email: string; name: string; role: AppRole; canvas_id?: number }> = [];
        const toIgnore: Array<{ email: string; name: string; role: AppRole; canvas_id?: number }> = [];

        processedUsers.forEach((user) => {
          if (existingUserEmails.includes(user.email!)) {
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
            await enrollmentAdd(
              {
                courseId: Number(course_id),
                email: user.email!,
                name: user.name!,
                role: user.role,
                canvasId: user.canvas_id
              },
              supabase
            );
            return { email: user.email, name: user.name, status: "fulfilled" };
          } catch (error) {
            return {
              email: user.email,
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
      reset();
      onClose();
    }
  };

  const handleClose = () => {
    reset();
    setIsPreviewMode(false);
    setUsersToPreviewAdd([]);
    setUsersToPreviewIgnore([]);
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(details) => !details.open && handleClose()}>
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
                          (user: { email: string; name: string; role: AppRole; canvas_id?: number }) => (
                            <Text as="li" key={user.email}>
                              {user.name} ({user.email}) - Role: {user.role}{" "}
                              {user.canvas_id !== undefined ? ` (Canvas ID: ${user.canvas_id})` : ""}
                            </Text>
                          )
                        )}
                      </VStack>
                    </Box>
                  )}
                  {usersToPreviewIgnore.length > 0 && (
                    <Box>
                      <Text fontWeight="bold" mb={2}>
                        Users already enrolled (will be ignored - {usersToPreviewIgnore.length}):
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
                          (user: { email: string; name: string; role: AppRole; canvas_id?: number }) => (
                            <Text as="li" key={user.email}>
                              {user.name} ({user.email}) - Role: {user.role}{" "}
                              {user.canvas_id !== undefined ? ` (Canvas ID: ${user.canvas_id})` : ""}
                            </Text>
                          )
                        )}
                      </VStack>
                    </Box>
                  )}
                  {usersToPreviewAdd.length === 0 && usersToPreviewIgnore.length > 0 && (
                    <Text>All users in the CSV are already enrolled in this course.</Text>
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
                      <Text fontSize="sm" color="fg.subtle" mt={1}>
                        Upload a CSV file with columns named &apos;email&apos;, &apos;name&apos;, and optionally
                        &apos;role&apos; (student, grader, instructor). Each row should represent a user. If
                        &apos;role&apos; is not provided or invalid, it defaults to &apos;student&apos;. You can also
                        include an optional &apos;canvas_id&apos; column.
                      </Text>
                    )}
                  </Field>
                  <Text fontSize="sm" color="gray.500">
                    New users will be enrolled into the course. Existing users will be ignored.
                  </Text>
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

export default ImportStudentsCSVModal;
