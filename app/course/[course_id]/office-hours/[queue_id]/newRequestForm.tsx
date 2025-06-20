import { createClient } from "@/utils/supabase/client";
import { useCallback } from "react";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useForm } from "@refinedev/react-hook-form";
import { RadioCardRoot, RadioCardItem } from "@/components/ui/radio-card";
import { Fieldset, Button, Heading, Text } from "@chakra-ui/react";
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { Field } from "@/components/ui/field";
import { Controller } from "react-hook-form";
import { useRouter } from "next/navigation";
import MdEditor from "@/components/ui/md-editor";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "chakra-react-select";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { useList as useListForFollowup } from "@refinedev/core";

type TemplateOption = { label: string; value: string };

export default function HelpRequestForm() {
  const { course_id } = useParams();
  const supabase = createClient();
  const router = useRouter();
  const {
    refineCore: { formLoading, query },
    setValue,
    control,
    getValues,
    formState: { errors, isSubmitting },
    handleSubmit,
    refineCore: { onFinish }
  } = useForm<HelpRequest>({
    defaultValues: async () => {
      const { data: queues } = await supabase.from("help_queues").select("*");
      return { help_queue: queues?.[0]?.id.toString() || "" };
    },
    refineCoreProps: {
      resource: "help_requests",
      action: "create",
      onMutationSuccess: (data) => {
        router.push(`/course/${course_id}/office-hours/${data.data.help_queue}`);
      }
    }
  });
  const { data: queues, error: queuesError } = useList<HelpQueue>({
    resource: "help_queues",
    meta: { select: "*" },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });
  const { private_profile_id } = useClassProfiles();
  const { data: previousRequests } = useListForFollowup<HelpRequest>({
    resource: "help_requests",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "creator", operator: "eq", value: private_profile_id },
      { field: "resolved_by", operator: "nnull", value: null }
    ],
    sorters: [{ field: "resolved_at", order: "desc" }],
    pagination: { pageSize: 20 }
  });
  const { data: templates, error: templatesError } = useList<
    Database["public"]["Tables"]["help_request_templates"]["Row"]
  >({
    resource: "help_request_templates",
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "is_active", operator: "eq", value: true }
    ]
  });

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      async function populate() {
        setValue("creator", private_profile_id!);
        setValue("class_id", Number.parseInt(course_id as string));
        const hqStr = getValues("help_queue") as unknown as string;
        if (typeof hqStr === "string") setValue("help_queue", Number.parseInt(hqStr) as unknown as number);
        handleSubmit(onFinish)();
      }
      populate();
    },
    [handleSubmit, onFinish, private_profile_id, course_id, setValue, getValues]
  );
  if (query?.error) {
    return <div>Error: {query.error.message}</div>;
  }
  if (queuesError) {
    return <div>Error: {queuesError.message}</div>;
  }
  if (templatesError) {
    return <div>Error: {templatesError.message}</div>;
  }

  if (!query || formLoading) {
    return <div>Loading...</div>;
  }

  return (
    <form onSubmit={onSubmit}>
      <Heading>Request Live Help</Heading>
      <Text>Submit a request to get help from a live tutor via text or video chat.</Text>
      <Fieldset.Root size="lg" maxW="100%">
        <Fieldset.Content>
          <Field
            label="Queue"
            required={true}
            errorText={errors.help_queue?.message?.toString()}
            invalid={errors.help_queue ? true : false}
          >
            <Controller
              name="help_queue"
              control={control}
              render={({ field }) => (
                <RadioCardRoot
                  orientation="vertical"
                  align="center"
                  justify="start"
                  maxW="4xl"
                  name={field.name}
                  value={field.value}
                  onChange={field.onChange}
                >
                  {queues?.data?.map((queue) => (
                    <RadioCardItem
                      key={queue.id}
                      label={queue.name}
                      colorPalette={queue.color || "gray"}
                      indicator={true}
                      description={queue.description}
                      value={queue.id.toString()}
                    />
                  ))}
                </RadioCardRoot>
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
        <Fieldset.Content>
          <Field label="Privacy" helperText="Private requests are only visible to staff." optionalText="Optional">
            <Controller
              name="is_private"
              control={control}
              defaultValue={false}
              render={({ field }) => (
                <Checkbox checked={field.value} onCheckedChange={field.onChange}>
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
                <RadioCardRoot orientation="horizontal" name={field.name} value={field.value} onChange={field.onChange}>
                  <RadioCardItem value="remote" label="Remote (Text)" />
                  <RadioCardItem value="in_person" label="In-Person" />
                </RadioCardRoot>
              )}
            />
          </Field>
        </Fieldset.Content>
        {templates?.data && templates.data.length > 0 && (
          <Fieldset.Content>
            <Field label="Template" optionalText="Optional">
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
            <Field label="Follow-up to previous request" optionalText="Optional">
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
      <Button type="submit" loading={isSubmitting}>
        Submit Request
      </Button>
    </form>
  );
}
