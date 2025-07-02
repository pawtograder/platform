import { createClient } from "@/utils/supabase/client";
import { useCallback } from "react";
import { useList } from "@refinedev/core";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "@refinedev/react-hook-form";
import { Fieldset, Button, Heading, Text } from "@chakra-ui/react";
import {
  HelpRequest,
  HelpRequestTemplate,
  HelpQueue,
  Submission,
  SubmissionFile,
  HelpRequestLocationType
} from "@/utils/supabase/DatabaseTypes";
import { Field } from "@/components/ui/field";
import { Controller } from "react-hook-form";
import MdEditor from "@/components/ui/md-editor";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "chakra-react-select";
import { toaster } from "@/components/ui/toaster";

type TemplateOption = { label: string; value: string };
type SubmissionOption = { label: string; value: string };
type FileOption = { label: string; value: string };
type QueueOption = { label: string; value: string };

// Form state for file references
type FileReference = {
  submission_file_id: number;
  line_number?: number;
};

const locationTypeOptions: HelpRequestLocationType[] = ["remote", "in_person", "hybrid"];

interface HelpRequestFormProps {
  currentRequest?: HelpRequest | null;
}

export default function HelpRequestForm({ currentRequest }: HelpRequestFormProps) {
  const { course_id, queue_id } = useParams();
  const supabase = createClient();
  const router = useRouter();
  const {
    refineCore: { formLoading, query },
    setValue,
    control,
    getValues,
    watch,
    formState: { errors, isSubmitting },
    handleSubmit,
    refineCore: { onFinish }
  } = useForm<HelpRequest & { file_references?: FileReference[] }>({
    defaultValues: async () => {
      return {
        help_queue: Number.parseInt(queue_id as string),
        file_references: [],
        location_type: "remote" as HelpRequestLocationType
      };
    },
    refineCoreProps: {
      resource: "help_requests",
      action: "create",
      onMutationSuccess: async (data) => {
        // After creating the help request, create file references if any
        const fileReferences = getValues("file_references") || [];
        if (fileReferences.length > 0) {
          for (const ref of fileReferences) {
            await supabase.from("help_request_file_references").insert({
              help_request_id: data.data.id,
              class_id: Number.parseInt(course_id as string),
              submission_file_id: ref.submission_file_id,
              submission_id: getValues("referenced_submission_id"),
              line_number: ref.line_number
            });
          }
        }
        router.push(`/course/${course_id}/office-hours/${queue_id}`);
      }
    }
  });

  const { private_profile_id } = useClassProfiles();

  // Fetch resolved/closed previous requests for follow-up options
  const { data: previousRequests } = useList<HelpRequest>({
    resource: "help_requests",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "creator", operator: "eq", value: private_profile_id },
      { field: "status", operator: "in", value: ["resolved", "closed"] }
    ],
    sorters: [{ field: "resolved_at", order: "desc" }],
    pagination: { pageSize: 20 }
  });

  const { data: templates, error: templatesError } = useList<HelpRequestTemplate>({
    resource: "help_request_templates",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "is_active", operator: "eq", value: true }
    ]
  });

  // Fetch available help queues for the class
  const { data: helpQueues } = useList<HelpQueue>({
    resource: "help_queues",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "is_active", operator: "eq", value: true },
      { field: "available", operator: "eq", value: true }
    ]
  });

  // Fetch student's submissions for file/submission references
  const { data: submissions } = useList<Submission>({
    resource: "submissions",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "profile_id", operator: "eq", value: private_profile_id }
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 50 }
  });

  // Watch the selected submission to fetch its files
  const selectedSubmissionId = watch("referenced_submission_id");
  const { data: submissionFiles } = useList<SubmissionFile>({
    resource: "submission_files",
    filters: [{ field: "submission_id", operator: "eq", value: selectedSubmissionId }],
    queryOptions: {
      enabled: !!selectedSubmissionId
    }
  });

  // Watch the selected help queue to validate against existing requests
  const selectedHelpQueue = watch("help_queue");

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      if (!private_profile_id) {
        toaster.error({
          title: "Error",
          description: "You must be logged in to submit a help request"
        });
        return;
      }

      // Check if user already has an active request in the selected queue
      const selectedQueueId = getValues("help_queue");
      if (currentRequest && currentRequest.help_queue === selectedQueueId) {
        toaster.error({
          title: "Error",
          description:
            "You already have an active request in this queue. Please resolve your current request before submitting a new one."
        });
        return;
      }

      // Create a custom onFinish function that excludes file_references and adds required fields
      const customOnFinish = (values: Record<string, unknown>) => {
        // Exclude file_references from the submission data since it's not a column in help_requests table
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { file_references, ...helpRequestData } = values;

        // Add required fields that may not be set in the form
        const finalData = {
          ...helpRequestData,
          creator: private_profile_id,
          assignee: null,
          class_id: Number.parseInt(course_id as string)
        };

        return onFinish(finalData);
      };

      handleSubmit(customOnFinish)();
    },
    [handleSubmit, onFinish, private_profile_id, course_id, currentRequest, getValues]
  );

  if (query?.error) {
    return <div>Error: {query.error.message}</div>;
  }
  if (templatesError) {
    return <div>Error: {templatesError.message}</div>;
  }

  if (!query || formLoading) {
    return <div>Loading...</div>;
  }

  // Check if the selected queue would conflict with current request
  const wouldConflict = Boolean(currentRequest && currentRequest.help_queue === selectedHelpQueue);

  return (
    <form onSubmit={onSubmit}>
      <Heading>Request Live Help</Heading>
      <Text>Submit a request to get help from a live tutor via text or video chat.</Text>

      {wouldConflict && (
        <Text color="orange.500" mb={4}>
          ⚠️ You already have an active request in this queue. Please resolve your current request before submitting a
          new one.
        </Text>
      )}

      <Fieldset.Root size="lg" maxW="100%">
        <Fieldset.Content>
          <Field
            label="Help Queue"
            required={true}
            errorText={errors.help_queue?.message?.toString()}
            invalid={!!errors.help_queue}
            helperText="Select which help queue to submit your request to"
          >
            <Controller
              name="help_queue"
              control={control}
              defaultValue={Number.parseInt(queue_id as string)}
              render={({ field }) => (
                <Select
                  isMulti={false}
                  placeholder="Select a help queue"
                  options={
                    helpQueues?.data?.map(
                      (queue) =>
                        ({
                          label: `${queue.name} - ${queue.description}`,
                          value: queue.id.toString()
                        }) as QueueOption
                    ) ?? []
                  }
                  value={
                    field.value
                      ? ({
                          label: helpQueues?.data?.find((q) => q.id === field.value)?.name || "Unknown",
                          value: field.value.toString()
                        } as QueueOption)
                      : null
                  }
                  onChange={(option: QueueOption | null) => {
                    const val = option?.value ?? "";
                    field.onChange(val === "" ? undefined : Number.parseInt(val));
                  }}
                />
              )}
            />
          </Field>
        </Fieldset.Content>

        <Fieldset.Content>
          <Field
            label="Message"
            required={true}
            errorText={errors.request?.message?.toString()}
            invalid={errors.request ? true : false}
          >
            <Controller
              name="request"
              control={control}
              render={({ field }) => {
                return <MdEditor style={{ width: "800px" }} onChange={field.onChange} value={field.value} />;
              }}
            />
          </Field>
        </Fieldset.Content>

        {/* Code/Submission Reference Section */}
        <Fieldset.Content>
          <Field
            label="Reference Submission "
            optionalText="(Optional)"
            helperText="Reference a specific submission for context"
          >
            <Controller
              name="referenced_submission_id"
              control={control}
              render={({ field }) => (
                <Select
                  isMulti={false}
                  isClearable={true}
                  placeholder="Select a submission to reference"
                  options={
                    submissions?.data?.map(
                      (submission) =>
                        ({
                          label: `${submission.repository} (${new Date(submission.created_at).toLocaleDateString()}) - Run #${submission.run_number}`,
                          value: submission.id.toString()
                        }) as SubmissionOption
                    ) ?? []
                  }
                  value={
                    field.value
                      ? ({
                          label: submissions?.data?.find((s) => s.id === field.value)?.repository || "Unknown",
                          value: field.value.toString()
                        } as SubmissionOption)
                      : null
                  }
                  onChange={(option: SubmissionOption | null) => {
                    const val = option?.value ?? "";
                    field.onChange(val === "" ? undefined : Number.parseInt(val));
                  }}
                />
              )}
            />
          </Field>
        </Fieldset.Content>

        {/* File References Section - Show only when a submission is selected */}
        {selectedSubmissionId && submissionFiles?.data && submissionFiles.data.length > 0 && (
          <Fieldset.Content>
            <Field
              label="Reference Specific Files "
              optionalText="(Optional)"
              helperText="Reference specific files and line numbers from your submission"
            >
              <Controller
                name="file_references"
                control={control}
                defaultValue={[]}
                render={({ field }) => (
                  <Select
                    isMulti={true}
                    isClearable={true}
                    placeholder="Select files to reference"
                    options={submissionFiles.data.map(
                      (file) =>
                        ({
                          label: file.name,
                          value: file.id.toString()
                        }) as FileOption
                    )}
                    value={
                      field.value?.map((ref: FileReference) => ({
                        label: submissionFiles.data.find((f) => f.id === ref.submission_file_id)?.name || "Unknown",
                        value: ref.submission_file_id.toString()
                      })) || []
                    }
                    onChange={(options) => {
                      if (!options) {
                        field.onChange([]);
                        return;
                      }
                      const newRefs = Array.from(options).map((option: FileOption) => ({
                        submission_file_id: Number.parseInt(option.value)
                      }));
                      field.onChange(newRefs);
                    }}
                  />
                )}
              />
            </Field>
          </Fieldset.Content>
        )}

        <Fieldset.Content>
          <Field label="Privacy " helperText="Private requests are only visible to staff." optionalText="(Optional)">
            <Controller
              name="is_private"
              control={control}
              defaultValue={false}
              render={({ field }) => (
                <Checkbox checked={field.value} onCheckedChange={({ checked }) => field.onChange(!!checked)}>
                  Private
                </Checkbox>
              )}
            />
          </Field>
        </Fieldset.Content>

        <Fieldset.Content>
          <Field
            label="Location"
            required
            errorText={errors.location_type?.message?.toString()}
            invalid={!!errors.location_type}
          >
            <Controller
              name="location_type"
              control={control}
              defaultValue="remote"
              render={({ field }) => (
                <Select
                  isMulti={false}
                  placeholder="Select location type"
                  options={locationTypeOptions.map((location) => ({
                    label: location.charAt(0).toUpperCase() + location.slice(1).replace("_", " "),
                    value: location
                  }))}
                  value={
                    field.value
                      ? {
                          label: field.value.charAt(0).toUpperCase() + field.value.slice(1).replace("_", " "),
                          value: field.value
                        }
                      : null
                  }
                  onChange={(option: { label: string; value: string } | null) => {
                    field.onChange(option?.value || null);
                  }}
                />
              )}
            />
          </Field>
        </Fieldset.Content>

        {templates?.data && templates.data.length > 0 && (
          <Fieldset.Content>
            <Field label="Template " optionalText="(Optional)">
              <Controller
                name="template_id"
                control={control}
                render={({ field }) => (
                  <Select
                    isMulti={false}
                    placeholder="Choose a template"
                    options={templates.data.map(
                      (tmpl) => ({ label: tmpl.name, value: tmpl.id.toString() }) as TemplateOption
                    )}
                    value={
                      field.value
                        ? ({
                            label: templates.data.find((t) => t.id === field.value)!.name,
                            value: field.value.toString()
                          } as TemplateOption)
                        : null
                    }
                    onChange={(option: TemplateOption | null) => {
                      // option can be null if cleared
                      const val = option?.value ?? "";
                      field.onChange(val === "" ? undefined : Number.parseInt(val));
                      const tmpl = templates.data.find((t) => t.id.toString() === val);
                      if (tmpl && !getValues("request")) {
                        setValue("request", tmpl.template_content);
                      }
                    }}
                  />
                )}
              />
            </Field>
          </Fieldset.Content>
        )}

        {previousRequests?.data && previousRequests.data.length > 0 && (
          <Fieldset.Content>
            <Field label="Follow-up to previous request " optionalText="(Optional)">
              <Controller
                name="followup_to"
                control={control}
                render={({ field }) => (
                  <Select
                    isMulti={false}
                    isClearable={true}
                    placeholder="Reference a previous request"
                    options={previousRequests.data.map(
                      (req) =>
                        ({
                          label: `${req.request.substring(0, 60)}${req.request.length > 60 ? "..." : ""} (${new Date(req.resolved_at!).toLocaleDateString()})`,
                          value: req.id.toString()
                        }) as TemplateOption
                    )}
                    value={
                      field.value
                        ? ({
                            label:
                              previousRequests.data.find((r) => r.id === field.value)?.request.substring(0, 60) +
                                "..." || "",
                            value: field.value.toString()
                          } as TemplateOption)
                        : null
                    }
                    onChange={(option: TemplateOption | null) => {
                      const val = option?.value ?? "";
                      field.onChange(val === "" ? undefined : Number.parseInt(val));
                    }}
                  />
                )}
              />
            </Field>
          </Fieldset.Content>
        )}
      </Fieldset.Root>
      <Button type="submit" loading={isSubmitting} disabled={wouldConflict} mt={4}>
        Submit Request
      </Button>
    </form>
  );
}
