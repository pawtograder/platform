"use client";
import { Assignment, Tag } from "@/utils/supabase/DatabaseTypes";
import { Button, Field, Fieldset, Heading, Input, Textarea, Box, Flex } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { useEffect, useRef, useState } from "react";
import useTags from "@/hooks/useTags";
import { useParams } from "next/navigation";
import TagDisplay from "@/components/ui/tag";
import { CreatableSelect } from "chakra-react-select";
import {
  AssignmentEmailInfo,
  EmailManagementProvider,
  GeneralEmailInfo,
  TagEmailInfo,
  useEmailManagement
} from "./EmailManagementContext";
import { toaster, Toaster } from "@/components/ui/toaster";
import EmailPreviewAndSend from "./previewAndSend";

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

function EmailsInnerPage() {
  const { course_id } = useParams();
  const { emailsToCreate, addEmail } = useEmailManagement();
  const [choice, setChoice] = useState<{ label: string; value: Audience | null }>();
  const [assignment, setAssignment] = useState<Assignment>();
  const [tag, setTag] = useState<Tag>();
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [ccList, setCcList] = useState<string[]>([]);
  const tags = useTags();
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

  const { data: userData } = useList({
    resource: "users",
    meta: {
      select: "email"
    }
  });
  const emails = userData?.data.map((item) => item.email);

  /**
   * Creates an email draft that will be held for the user to review and send.  The main computation is "audience"
   * which is an object populated in one of three formats using the data the user entered / selected in the first few
   * fields. Using three objects rather than a variety of optional fields ensures all the information is stored for one of
   * the three choices, and nothing more/less.
   */
  const prepareMail = () => {
    let audience: AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo;
    switch (choice?.value) {
      case Audience.Submitted:
        if (!assignment) {
          toaster.error({ title: "Failed to find assignment" });
          return;
        }
        audience = { type: "assignment", assignment: assignment, submissionType: "submitted" };
        break;
      case Audience.NotSubmitted:
        if (!assignment) {
          toaster.error({ title: "Failed to find assignment" });
          return;
        }
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
        if (!tag) {
          toaster.error({ title: "Failed to find tag" });
          return;
        }
        audience = { type: "tag", tag: tag };
        break;
      default:
        return;
    }
    addEmail({ subject: subjectLine, body: body, cc_emails: ccList, audience: audience });
  };

  // only clear the form when the size of emails to create increases (someone drafts a new email)
  // don't clear the form if instructor deletes another email draft midway through
  const prevEmailsToCreateLength = useRef(emailsToCreate.length);
  useEffect(() => {
    if (emailsToCreate.length > prevEmailsToCreateLength.current) {
      setSubjectLine("");
      setBody("");
      setCcList([]);
      setChoice({ label: "", value: null });
      setTag(undefined);
      setAssignment(undefined);
    }
    prevEmailsToCreateLength.current = emailsToCreate.length;
  }, [emailsToCreate]);

  return (
    <>
      <Flex gap="10" width="100%" wrap={{ base: "wrap", lg: "nowrap" }}>
        <Toaster />
        <Box width={{ base: "100%" }}>
          <Heading size="lg" mt="5" mb="5">
            Draft email
          </Heading>
          <Fieldset.Root>
            <Fieldset.Content>
              <Field.Root>
                <Field.Label>Select audience</Field.Label>
                <Select
                  isClearable={true}
                  onChange={(e) => {
                    if (e) {
                      setChoice(e);
                    }
                  }}
                  value={choice}
                  options={options}
                />
              </Field.Root>
              {choice && (choice.value === Audience.NotSubmitted || choice.value == Audience.Submitted) && (
                <Field.Root>
                  <Field.Label>Choose assignment</Field.Label>
                  <Select
                    onChange={(e) => (e ? setAssignment(e.value) : null)}
                    options={assignmentsData?.data.map((a: Assignment) => ({ label: a.title, value: a }))}
                  />
                </Field.Root>
              )}
              {choice && choice.value === Audience.Tag && (
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
                <CreatableSelect
                  value={ccList.map((item) => ({ label: item, value: item }))}
                  onChange={(e) => setCcList(Array.from(e?.map((item) => item.value.toString()) || []))}
                  isMulti={true}
                  options={emails?.map((a: string) => ({ label: a, value: a }))}
                  placeholder="Select or type email addresses..."
                />
              </Field.Root>
              <Field.Root>
                <Field.Label>Subject</Field.Label>
                <Input value={subjectLine} onChange={(e) => setSubjectLine(e.target.value)} />
              </Field.Root>
              <Field.Root>
                <Field.Label>Body</Field.Label>
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} />
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
        <EmailPreviewAndSend tags={tags.tags} />
      </Flex>
    </>
  );
}

export default function EmailsPage() {
  return (
    <EmailManagementProvider>
      <EmailsInnerPage />
    </EmailManagementProvider>
  );
}
