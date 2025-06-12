"use client";
import { Assignment, Tag } from "@/utils/supabase/DatabaseTypes";
import { Button, Field, Fieldset, Text, Heading, Input, Textarea, Box, Flex, Card } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { useState } from "react";
import useTags from "@/hooks/useTags";
import { useParams } from "next/navigation";
import TagDisplay from "@/components/ui/tag";
import {
  AssignmentEmailInfo,
  EmailCreateData,
  EmailManagementProvider,
  GeneralEmailInfo,
  TagEmailInfo,
  useEmailManagement
} from "./context";
import { IoMdClose } from "react-icons/io";

enum Audience {
  All = "all",
  CourseStaff = "courseStaff",
  Graders = "graders",
  Students = "students",
  Instructors = "instructors",
  Tag = "tag",
  Submitted = "submitted",
  NotSubmitted = "notSubmitted"
}

function Page() {
  const { course_id } = useParams();
  const [choice, setChoice] = useState<Audience>();
  const [assignment, setAssignment] = useState<Assignment>();
  const [tag, setTag] = useState<Tag>();
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");

  const options = [
    { label: "Students who have submitted an assignment", value: Audience.Submitted },
    { label: "Students who have not submitted an assignment", value: Audience.NotSubmitted },
    { label: "Instructors, Graders, and Students", value: Audience.All },
    { label: "Instructors and Graders", value: Audience.CourseStaff },
    { label: "Students", value: Audience.Students },
    { label: "Graders", value: Audience.Graders },
    { label: "Instructors", value: Audience.Instructors },
    { label: "Tag", value: Audience.Tag }
  ];

  const { data: assignmentsData } = useList<Assignment>({
    resource: "assignments",
    meta: {
      select: "*"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  const tags = useTags();
  const { emailsToCreate, setEmailsToCreate } = useEmailManagement();

  const uniqueTags: Tag[] = Array.from(
    tags.tags
      .reduce((map, tag) => {
        if (!map.has(tag.name + tag.color + tag.visible)) {
          map.set(tag.name + tag.color + tag.visible, tag);
        }
        return map;
      }, new Map())
      .values()
  );
  const emailToAudienceText = (email: EmailCreateData) => {
    if (email.audience.type === "assignment") {
      return "Students who have " + email.audience.submissionType + " " + email.audience.assignment.title;
    } else if (email.audience.type === "tag") {
      return "Anyone who is tagged with " + <TagDisplay tag={email.audience.tag} />;
    } else if (email.audience.type === "general") {
      let str = "";
      if (email.audience.includeInstructors) {
        str += "Instructors ";
      }
      if (email.audience.includeGraders) {
        str += "Graders ";
      }
      if (email.audience.includeStudents) {
        str += "Students";
      }
      return str;
    }
    return "No audience selected";
  };

  const prepareMail = () => {
    let audience: AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo;
    switch (choice) {
      case Audience.Submitted:
        if (!assignment) return;
        audience = { type: "assignment", assignment: assignment, submissionType: "submitted" };
        break;
      case Audience.NotSubmitted:
        if (!assignment) return;
        audience = { type: "assignment", assignment: assignment, submissionType: "not submitted" };
        break;
      case Audience.All:
        audience = { type: "general", includeInstructors: true, includeStudents: true, includeGraders: true };
        break;
      case Audience.CourseStaff:
        audience = { type: "general", includeInstructors: true, includeStudents: false, includeGraders: true };
        break;
      case Audience.Students:
        audience = { type: "general", includeInstructors: false, includeStudents: true, includeGraders: false };
        break;
      case Audience.Graders:
        audience = { type: "general", includeInstructors: false, includeStudents: false, includeGraders: true };
        break;
      case Audience.Instructors:
        audience = { type: "general", includeInstructors: true, includeStudents: false, includeGraders: false };
        break;
      case Audience.Tag:
        if (!tag) return;
        audience = { type: "tag", tag: tag };
      default:
        return;
    }
    setEmailsToCreate([...emailsToCreate, { subject: subjectLine, body: body, cc_emails: [], audience: audience }]);
  };

  return (
    <>
      <Flex gap="10" width="100%" wrap={{ base: "wrap", lg: "nowrap" }}>
        <Box width={{ base: "100%", lg: "40%" }}>
          <Heading size="lg" mt="5" mb="5">
            Draft email
          </Heading>
          <Fieldset.Root>
            <Fieldset.Content>
              <Field.Root>
                <Field.Label>Select audience</Field.Label>
                <Select onChange={(e) => (e ? setChoice(e.value) : null)} options={options} />
              </Field.Root>
              {choice && (choice === Audience.NotSubmitted || choice == Audience.Submitted) && (
                <Field.Root>
                  <Field.Label>Choose assignment</Field.Label>
                  <Select
                    onChange={(e) => (e ? setAssignment(e.value) : null)}
                    options={assignmentsData?.data.map((a: Assignment) => ({ label: a.title, value: a }))}
                  />
                </Field.Root>
              )}
              {choice && choice === Audience.Tag && (
                <Field.Root>
                  <Field.Label>Select Tag</Field.Label>
                  <Select
                    getOptionValue={(option) => option.value.id}
                    onChange={(e) => {
                      setTag(e?.value);
                    }}
                    options={uniqueTags.map((tag) => ({ label: tag.name, value: tag }))}
                    components={{
                      Option: ({ data, ...props }) => (
                        <Box
                          key={data.value.id}
                          {...props.innerProps}
                          p="4px 8px"
                          cursor="pointer"
                          _hover={{ bg: "gray.100" }}
                        >
                          {data.value ? <TagDisplay tag={data.value} /> : <div>{data.label}</div>}
                        </Box>
                      )
                    }}
                  />
                </Field.Root>
              )}
              <Field.Root>
                <Field.Label>Cc</Field.Label>
                <Input onChange={(e) => setSubjectLine(e.target.value)} />
              </Field.Root>
              <Field.Root>
                <Field.Label>Subject</Field.Label>
                <Input onChange={(e) => setSubjectLine(e.target.value)} />
              </Field.Root>
              <Field.Root>
                <Field.Label>Body</Field.Label>
                <Textarea onChange={(e) => setBody(e.target.value)} />
              </Field.Root>
              <Field.Root>
                <Flex gap="2" alignItems="center">
                  <Button
                    onClick={() => {
                      prepareMail();
                    }}
                  >
                    Prepare mail
                  </Button>
                  <Field.HelperText>You&apos;ll be able to review the email before it is sent</Field.HelperText>
                </Flex>
              </Field.Root>
            </Fieldset.Content>
          </Fieldset.Root>
        </Box>
        <Box width={{ base: "100%", lg: "40%" }}>
          <Heading size="lg" mt="5" mb="5">
            Preview and send
          </Heading>
          {emailsToCreate.length > 0 ? (
            <Box spaceY="4">
              {emailsToCreate.map((email, key) => {
                return (
                  <Card.Root key={key} padding="2" mt="5" maxWidth="2xl" size="sm">
                    <Flex justifyContent={"space-between"}>
                      <Card.Title>Subject: {email.subject}</Card.Title>
                      <Text
                        onClick={() =>
                          setEmailsToCreate(
                            emailsToCreate.filter((e) => {
                              return e != email;
                            })
                          )
                        }
                      >
                        <IoMdClose />
                      </Text>
                    </Flex>
                    <Flex flexDir={"column"} fontSize="sm">
                      <Text>To: {emailToAudienceText(email)}</Text>
                      <Text>
                        Cc:{" "}
                        {email.cc_emails.map((cc) => {
                          return cc + " ";
                        })}
                      </Text>
                      <Text>Body: {email.body}</Text>
                    </Flex>
                  </Card.Root>
                );
              })}
              <Button>Send emails</Button>
            </Box>
          ) : (
            <Text>No emails drafted at this time</Text>
          )}
        </Box>
      </Flex>
    </>
  );
}

export default function WrappedPage() {
  return (
    <EmailManagementProvider>
      <Page />
    </EmailManagementProvider>
  );
}
