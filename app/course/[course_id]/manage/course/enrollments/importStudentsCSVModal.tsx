"use client";
import { useState } from "react";
import { Input, VStack, Text, Dialog, Portal } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useForm, SubmitHandler } from "react-hook-form";
import { parse } from "csv-parse/browser/esm/sync";
import { useParams } from "next/navigation";
import { useInvalidate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { toaster } from "@/components/ui/toaster";
import { enrollmentAdd } from "@/lib/edgeFunctions";

type CSVRecord = {
  email: string;
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
  const invalidate = useInvalidate();
  const supabase = createClient();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset
  } = useForm<FormValues>();

  const processImport: SubmitHandler<FormValues> = async (data) => {
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

        const studentEmails = records.map((record) => record.email?.trim()).filter((email) => email);

        if (studentEmails.length === 0) {
          toaster.create({
            title: "No Emails Found",
            description: "No valid email addresses found in the CSV.",
            type: "warning"
          });
          setIsLoading(false);
          return;
        }

        const results = await Promise.allSettled(
          studentEmails.map(async (email) => {
            const name = email.split("@")[0];
            try {
              await enrollmentAdd({ courseId: Number(course_id), email, name, role: "student" }, supabase);
              return { email, status: "fulfilled" };
            } catch (error) {
              return { email, status: "rejected", reason: error instanceof Error ? error.message : "Unknown error" };
            }
          })
        );

        const successfulEnrollments = results.filter((r) => r.status === "fulfilled").length;
        const failedEnrollments = results.filter((r) => r.status === "rejected");

        if (successfulEnrollments > 0) {
          toaster.create({
            title: "Import Processed",
            description:
              `Successfully enrolled ${successfulEnrollments} out of ${studentEmails.length} students. ` +
              (failedEnrollments.length > 0 ? `${failedEnrollments.length} failed.` : ""),
            type: successfulEnrollments === studentEmails.length ? "success" : "warning"
          });
          invalidate({ resource: "user_roles", invalidates: ["all"] });
          invalidate({ resource: "profiles", invalidates: ["all"] });
        } else {
          if (studentEmails.length > 0) {
            toaster.create({
              title: "Import Failed",
              description: `Failed to enroll all ${failedEnrollments.length} provided email(s). Please check the email addresses and try again.`,
              type: "error"
            });
          }
        }

        reset();
        onClose();
      } catch (error) {
        toaster.create({
          title: "CSV Parsing or Processing Error",
          description: error instanceof Error ? error.message : "Could not process the CSV file.",
          type: "error"
        });
        setIsLoading(false);
      }
    };

    reader.onerror = () => {
      toaster.create({ title: "File Read Error", description: "Could not read the selected file.", type: "error" });
      setIsLoading(false);
    };

    reader.readAsText(file);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(details) => !details.open && handleClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={handleSubmit(processImport)}>
            <Dialog.Header>
              <Dialog.Title>Import Students from CSV</Dialog.Title>
              <Dialog.CloseTrigger onClick={handleClose} />
            </Dialog.Header>
            <Dialog.Body>
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
                      Upload a CSV file with a column named &apos;email&apos;. Each row should represent a student.
                    </Text>
                  )}
                </Field>
                <Text fontSize="sm" color="gray.500">
                  New users will be enrolled into the course.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
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
                Import Students
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};

export default ImportStudentsCSVModal;
