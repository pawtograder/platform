"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import MessageInput from "@/components/ui/message-input";
import { RadioCardItem, RadioCardLabel, RadioCardRoot } from "@/components/ui/radio-card";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useAssignments, useCourseController, useDiscussionTopics } from "@/hooks/useCourseController";
import { Box, Fieldset, Flex, Heading, Icon, Input, Text, Separator } from "@chakra-ui/react";
import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { FaChalkboardTeacher, FaQuestion, FaRegStickyNote, FaUser, FaUserSecret } from "react-icons/fa";
import { TbWorld } from "react-icons/tb";

type FormData = {
  topic_id: string;
  is_question: string;
  is_instructors_only: string;
  is_anonymous: string;
  subject: string;
  body: string;
};

export default function NewDiscussionThread() {
  const { course_id } = useParams();
  const router = useRouter();
  const { private_profile_id, public_profile_id, public_profile } = useClassProfiles();
  const { discussionThreadTeasers } = useCourseController();

  const {
    handleSubmit,
    register,
    control,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<FormData>({
    defaultValues: {
      is_question: "false",
      is_instructors_only: "false",
      is_anonymous: "false"
    }
  });

  const topics = useDiscussionTopics();
  const assignments = useAssignments();
  const topicId = watch("topic_id");

  /**
   * Create a map of assignment IDs to assignment titles for display.
   */
  const assignmentMap = useMemo(() => {
    const map = new Map<number, string>();
    assignments.forEach((a) => map.set(a.id, a.title));
    return map;
  }, [assignments]);

  /**
   * Group topics into general topics (no assignment link) and assignment-linked topics.
   * Sort each group by ordinal for consistent display order.
   */
  const { generalTopics, assignmentTopics } = useMemo(() => {
    if (!topics) return { generalTopics: [], assignmentTopics: [] };

    const general = topics.filter((t) => !t.assignment_id).sort((a, b) => a.ordinal - b.ordinal);
    const assignment = topics.filter((t) => t.assignment_id).sort((a, b) => a.ordinal - b.ordinal);

    return { generalTopics: general, assignmentTopics: assignment };
  }, [topics]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      // Prepare the thread data for creation
      const threadData = {
        subject: data.subject,
        body: data.body,
        topic_id: Number(data.topic_id),
        is_question: data.is_question === "true",
        instructors_only: data.is_instructors_only === "true",
        author: data.is_anonymous === "true" ? public_profile_id! : private_profile_id!,
        class_id: Number.parseInt(course_id as string),
        root_class_id: Number.parseInt(course_id as string)
      };

      // Create the thread using TableController
      const createdThread = await discussionThreadTeasers.create(threadData);

      // Navigate to the new thread
      router.push(`/course/${course_id}/discussion/${createdThread.id}`);
    } catch {
      toaster.error({
        title: "Error creating discussion thread",
        description: "Please try again later."
      });
    }
  });
  return (
    <Box p={{ base: "4", md: "0" }}>
      <Heading as="h1">New Discussion Thread</Heading>
      <Box maxW="4xl" w="100%">
        <form onSubmit={onSubmit}>
          <Fieldset.Root bg="surface">
            <Fieldset.Content w="100%">
              <Field
                label="Topic"
                helperText={topicId && topics?.find((topic) => topic.id === Number(topicId))?.description}
                errorText={errors.topic_id?.message?.toString()}
                invalid={!!errors.topic_id}
              >
                <Controller
                  control={control}
                  name="topic_id"
                  rules={{ required: "Please select a topic" }}
                  render={({ field }) => {
                    return (
                      <RadioCardRoot
                        orientation="vertical"
                        align="center"
                        justify="start"
                        w="100%"
                        name={field.name}
                        value={field.value}
                        onChange={field.onChange}
                      >
                        {/* General Topics Section */}
                        <Flex flexWrap="wrap" gap="2" w="100%">
                          {generalTopics.map((topic) => (
                            <Box key={topic.id} flex="1" minW={{ base: "100%", lg: "40%" }}>
                              <RadioCardItem
                                w="100%"
                                p="0"
                                m="0"
                                indicator={false}
                                colorPalette={topic.color}
                                description={topic.description}
                                value={topic.id?.toString() || ""}
                                label={topic.topic}
                              />
                            </Box>
                          ))}
                        </Flex>

                        {/* Assignment-Linked Topics Section */}
                        {assignmentTopics.length > 0 && (
                          <>
                            <Flex align="center" w="100%" gap="2" my="3">
                              <Separator flex="1" />
                              <Text fontSize="sm" color="fg.muted" fontWeight="medium">
                                Assignment Topics
                              </Text>
                              <Separator flex="1" />
                            </Flex>
                            <Flex flexWrap="wrap" gap="2" w="100%">
                              {assignmentTopics.map((topic) => {
                                const assignmentTitle = topic.assignment_id
                                  ? assignmentMap.get(topic.assignment_id)
                                  : undefined;
                                return (
                                  <Box key={topic.id} flex="1" minW={{ base: "100%", lg: "40%" }}>
                                    <RadioCardItem
                                      w="100%"
                                      p="0"
                                      m="0"
                                      indicator={false}
                                      colorPalette={topic.color}
                                      description={
                                        assignmentTitle
                                          ? `${topic.description} (${assignmentTitle})`
                                          : topic.description
                                      }
                                      value={topic.id?.toString() || ""}
                                      label={topic.topic}
                                    />
                                  </Box>
                                );
                              })}
                            </Flex>
                          </>
                        )}
                      </RadioCardRoot>
                    );
                  }}
                />
              </Field>
            </Fieldset.Content>
            <Fieldset.Content>
              <Controller
                control={control}
                name="is_question"
                render={({ field }) => {
                  return (
                    <RadioCardRoot
                      orientation="horizontal"
                      align="center"
                      justify="center"
                      w="100%"
                      name={field.name}
                      value={field.value}
                      onChange={field.onChange}
                    >
                      <RadioCardLabel>Post Type</RadioCardLabel>
                      <Flex flexWrap="wrap" gap="2" w="100%">
                        <Box flex="1" minW={{ base: "100%", lg: "40%" }}>
                          <RadioCardItem
                            w="100%"
                            value="true"
                            indicator={false}
                            icon={
                              <Icon fontSize="2xl" color="fg.muted" mb="2">
                                <FaQuestion />
                              </Icon>
                            }
                            description="If you need an answer"
                            label="Question"
                          />
                        </Box>
                        <Box flex="1" minW={{ base: "100%", lg: "40%" }}>
                          <RadioCardItem
                            w="100%"
                            value="false"
                            label="Note"
                            indicator={false}
                            icon={
                              <Icon fontSize="2xl" color="fg.muted" mb="2">
                                <FaRegStickyNote />
                              </Icon>
                            }
                            description="If you do not need an answer"
                          />
                        </Box>
                      </Flex>
                    </RadioCardRoot>
                  );
                }}
              />
            </Fieldset.Content>
            <Fieldset.Content>
              <Controller
                control={control}
                name="is_instructors_only"
                render={({ field }) => {
                  return (
                    <RadioCardRoot
                      orientation="horizontal"
                      align="center"
                      justify="center"
                      w="100%"
                      name={field.name}
                      value={field.value}
                      onChange={field.onChange}
                    >
                      <RadioCardLabel>Post Visibility</RadioCardLabel>
                      <Flex flexWrap="wrap" gap="2" w="100%">
                        <Box flex="1" minW={{ base: "100%", lg: "40%" }}>
                          <RadioCardItem
                            w="100%"
                            value="false"
                            label="Entire Class"
                            indicator={false}
                            icon={
                              <Icon fontSize="2xl" color="fg.muted" mb="2">
                                <TbWorld />
                              </Icon>
                            }
                            description="Fastest response - other students can provide support."
                          />
                        </Box>

                        <Box flex="1" minW={{ base: "100%", lg: "40%" }}>
                          <RadioCardItem
                            w="100%"
                            value="true"
                            indicator={false}
                            icon={
                              <Icon fontSize="2xl" color="fg.muted" mb="2">
                                <FaChalkboardTeacher />
                              </Icon>
                            }
                            description="Only course staff can see this post. Good if you need to share private assignment details."
                            label="Staff only"
                          />
                        </Box>
                      </Flex>
                    </RadioCardRoot>
                  );
                }}
              />
            </Fieldset.Content>
            <Fieldset.Content>
              <Controller
                control={control}
                name="is_anonymous"
                render={({ field }) => {
                  return (
                    <RadioCardRoot
                      orientation="horizontal"
                      align="center"
                      justify="center"
                      w="100%"
                      name={field.name}
                      value={field.value}
                      onChange={field.onChange}
                    >
                      <RadioCardLabel>Post Anonymity</RadioCardLabel>
                      <Flex flexWrap="wrap" gap="2" w="100%">
                        <Box flex="1" minW={{ base: "100%", lg: "40%" }}>
                          <RadioCardItem
                            w="100%"
                            value="false"
                            label={`Post with your name`}
                            indicator={false}
                            icon={
                              <Icon fontSize="2xl" color="fg.muted" mb="2">
                                <FaUser />
                              </Icon>
                            }
                            description="Your name will be displayed to other students."
                          />
                        </Box>

                        <Box flex="1" minW={{ base: "100%", lg: "40%" }}>
                          <RadioCardItem
                            w="100%"
                            value="true"
                            indicator={false}
                            icon={
                              <Icon fontSize="2xl" color="fg.muted" mb="2">
                                <FaUserSecret />
                              </Icon>
                            }
                            description={`Students will see your pseudonym (${public_profile.name}), course staff will always see your real name.`}
                            label="Use your pseudonym"
                          />
                        </Box>
                      </Flex>
                    </RadioCardRoot>
                  );
                }}
              />
            </Fieldset.Content>
            <Fieldset.Content>
              <Field
                maxWidth={"100%"}
                label="Subject"
                helperText="A short, descriptive subject for your post. Be specific."
                errorText={errors.subject?.message?.toString()}
                invalid={!!errors.subject}
              >
                <Input variant="outline" type="text" {...register("subject", { required: "Subject is required" })} />
              </Field>
            </Fieldset.Content>
            <Fieldset.Content>
              <Field
                label="Description"
                helperText="A detailed description of your post. Be specific."
                errorText={errors.body?.message?.toString()}
                invalid={!!errors.body}
              >
                <Controller
                  name="body"
                  control={control}
                  rules={{ required: "Description is required" }}
                  render={({ field }) => {
                    return (
                      <MessageInput
                        style={{ minWidth: "100%", width: "100%" }}
                        onChange={field.onChange}
                        value={field.value}
                      />
                    );
                  }}
                />
              </Field>
            </Fieldset.Content>
            <Button type="submit" loading={isSubmitting} disabled={isSubmitting} w="100%" colorPalette="green">
              Submit
            </Button>
          </Fieldset.Root>
        </form>
      </Box>
    </Box>
  );
}
