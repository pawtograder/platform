"use client";
import { useForm } from "@refinedev/react-hook-form";
import { Field } from "@/components/ui/field";
import { Fieldset, Input } from "@chakra-ui/react";
import { HelpQueue, HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { Controller } from "react-hook-form";
import { RadioCardRoot, RadioCardItem } from "@/components/ui/radio-card";
export default function HelpRequestForm() {
  console.log("HelpRequestForm");
  const { course_id } = useParams();
  const {
    refineCore: { formLoading, query },
    register,
    control,
    formState: { errors }
  } = useForm<HelpRequest>({ refineCoreProps: { resource: "help_requests", action: "create" } });
  console.log(course_id);
  const { data: queues, error: queuesError } = useList<HelpQueue>({
    resource: "help_queues",
    meta: { select: "*" }
    // filters:
    //     [
    //         { field: "class", operator: "eq", value: course_id }
    //     ]
  });
  console.log("Queues stuff");
  console.log(queuesError);
  console.log(queues?.total);
  if (query?.error) {
    return <div>Error: {query.error.message}</div>;
  }
  if (queuesError) {
    return <div>Error: {queuesError.message}</div>;
  }

  if (!query || formLoading) {
    return <div>Loading...</div>;
  }

  return (
    <form>
      {queues?.total}
      <Fieldset.Root size="lg" maxW="md">
        <Fieldset.Content>
          <Field
            label="Queue"
            errorText={errors.help_queue?.message?.toString()}
            invalid={errors.help_queue ? true : false}
          >
            <Controller
              name="help_queue"
              control={control}
              render={() => (
                <RadioCardRoot>
                  {queues?.data?.map((queue) => (
                    <RadioCardItem key={queue.id} value={queue.id.toString()}>
                      {queue.name}
                    </RadioCardItem>
                  ))}
                </RadioCardRoot>
              )}
            />
          </Field>
        </Fieldset.Content>
        <Fieldset.Content>
          <Field
            label="Message"
            errorText={errors.message?.message?.toString()}
            invalid={errors.message ? true : false}
          >
            <Input {...register("message")} />
          </Field>
        </Fieldset.Content>
      </Fieldset.Root>
    </form>
  );
}
