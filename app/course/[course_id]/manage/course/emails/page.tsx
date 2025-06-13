"use client";
import { Assignment, Submission, Tag, UserRole } from "@/utils/supabase/DatabaseTypes";
import { Button, Field, Fieldset, Text, Heading, Input, Textarea, Box, Flex, Card } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { Dispatch, SetStateAction, useEffect, useState } from "react";
import useTags from "@/hooks/useTags";
import { useParams } from "next/navigation";
import TagDisplay from "@/components/ui/tag";
import { CreatableSelect } from "chakra-react-select";

import {
  AssignmentEmailInfo,
  EmailCreateData,
  EmailManagementProvider,
  GeneralEmailInfo,
  TagEmailInfo,
  useEmailManagement
} from "./context";
import { IoMdClose } from "react-icons/io";
import { toaster } from "@/components/ui/toaster";

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
  const [choice, setChoice] = useState<Audience>();
  const [assignment, setAssignment] = useState<Assignment>();
  const [tag, setTag] = useState<Tag>();
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [ccList, setCcList] = useState<string[]>([]);

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

  const { data: userData } = useList({
    resource: "users",
    meta: {
      select: "email"
    }
  });
  const emails = userData?.data.map((item) => item.email);

  const prepareMail = () => {
    console.log("prepare hit");
    let audience: AssignmentEmailInfo | TagEmailInfo | GeneralEmailInfo;
    switch (choice) {
      case Audience.Submitted:
        if (!assignment) {
          toaster.error({ title: "Failed to find assignment" });
          return;
        }
        audience = { type: "assignment", assignment: assignment, submissionType: "submitted" };
        break;
      case Audience.NotSubmitted:
        if (!assignment) {
          console.log("assignmenthit");
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
    console.log(audience);
    setEmailsToCreate([...emailsToCreate, { subject: subjectLine, body: body, cc_emails: ccList, audience: audience }]);
  };

  useEffect(() => {
    // clear form once emailsToCreate has been properly updated
    setSubjectLine("");
    setBody("");
    setCcList([]);
    setChoice(undefined);
    setTag(undefined);
    setAssignment(undefined);
  }, [emailsToCreate]);

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
                <Select
                  isClearable={true}
                  onChange={(e) => {
                    if (e) {
                      setChoice(e.value);
                    }
                  }}
                  options={options}
                />
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
        <EmailPreviewAndSend
          course_id={course_id}
          emailsToCreate={emailsToCreate}
          setEmailsToCreate={setEmailsToCreate}
          tags={tags.tags}
        />
      </Flex>
    </>
  );
}

function EmailPreviewAndSend({
  course_id,
  emailsToCreate,
  setEmailsToCreate,
  tags
}: {
  course_id: string | string[] | undefined;
  emailsToCreate: EmailCreateData[];
  setEmailsToCreate: Dispatch<SetStateAction<EmailCreateData[]>>;
  tags: Tag[];
}) {
  const { data: userRolesData } = useList<UserRole & { users: { email: string } }>({
    resource: "user_roles",
    meta: {
      select: "*, users!user_roles_user_id_fkey1(email)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  type SubmissionEmails = Submission & {
    // emails for individual submissions
    user_roles: {
      users: {
        email: string;
      };
    } | null;
    // emails for group submissions
    assignment_groups: {
      assignment_groups_members: {
        user_roles: {
          users: {
            email: string;
          };
        };
      }[];
    } | null;
  };

  const { data: submissions } = useList<SubmissionEmails>({
    resource: "submissions",
    meta: {
      select: `
      *,
        user_roles!submissions_profile_id_fkey (
          users!user_roles_user_id_fkey1 (
            email
          )
        ),
        assignment_groups!submissions_assignment_group_id_fkey (
          assignment_groups_members!assignment_groups_members_assignment_group_id_fkey (
              user_roles!assignment_groups_members_profile_id_fkey1(
                users!user_roles_user_id_fkey1 (
                  email
            )
        )
          )
        )
      `
    },
    filters: [
      { field: "class_id", operator: "eq", value: course_id },
      { field: "is_active", operator: "eq", value: true }
    ]
  });

  const emailToAudienceText = (email: EmailCreateData) => {
    if (email.audience.type === "assignment") {
      return (
        <>
          Students who have {email.audience.submissionType} {email.audience.assignment.title}
        </>
      );
    } else if (email.audience.type === "tag") {
      return (
        <>
          Anyone who is tagged with <TagDisplay tag={email.audience.tag} />
        </>
      );
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
      return <>{str}</>;
    }
    return <>No audience selected</>;
  };

  const sendEmails = () => {
    emailsToCreate.forEach(async (emailToCreate) => {
      await sendEmail(emailToCreate);
    });
  };
  const sendEmail = async (emailToCreate: EmailCreateData) => {
    const emails = getEmailsToSendTo(emailToCreate);
    console.log(emails);
  };

  const getEmailsToSendTo = (emailToCreate: EmailCreateData) => {
    const recipients = [];
    if (emailToCreate.audience.type === "assignment") {
      const assignment = emailToCreate.audience.assignment;
      const submittedEmails =
        submissions?.data
          .filter((submission) => {
            return submission.assignment_id == assignment.id;
          })
          .map((submission) => {
            return submission.user_roles
              ? [submission.user_roles.users.email]
              : submission.assignment_groups
                ? submission.assignment_groups.assignment_groups_members.map((member) => {
                    return member.user_roles.users.email.toString();
                  })
                : [];
          })
          .reduce((prev, next) => {
            return prev.concat(next);
          }, []) ?? [];
      if (emailToCreate.audience.submissionType === "submitted") {
        recipients.push(submittedEmails);
      } else if (emailToCreate.audience.submissionType === "not submitted") {
        const studentEmailsForClass = userRolesData?.data
          .filter((user) => {
            return user.role === "student";
          })
          .map((user) => {
            return user.users.email;
          });
        recipients.push(
          studentEmailsForClass?.filter((email) => {
            return !submittedEmails.includes(email);
          })
        );
      }
    } else if (emailToCreate.audience.type === "tag") {
      const chosenTag = emailToCreate.audience.tag;
      const profile_ids = tags
        .filter((tag) => {
          return tag.color == chosenTag.color && tag.name == chosenTag.name && tag.visible === chosenTag.visible;
        })
        .map((tag) => {
          return tag.profile_id;
        });
      const emails = userRolesData?.data
        .filter((user) => {
          return profile_ids.includes(user.private_profile_id);
        })
        .map((user) => {
          return user.users.email;
        });
      recipients.push(emails);
    } else if (emailToCreate.audience.type === "general") {
      const roles: string[] = [];
      if (emailToCreate.audience.includeGraders) {
        roles.push("grader");
      }
      if (emailToCreate.audience.includeInstructors) {
        roles.push("instructor");
      }
      if (emailToCreate.audience.includeStudents) {
        roles.push("student");
      }
      recipients.push(
        userRolesData?.data
          .filter((userRole) => {
            return roles.includes(userRole.role);
          })
          .map((userRole) => {
            return userRole.users.email;
          })
      );
    }
    return recipients;
  };

  return (
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
          <Button
            onClick={() => {
              sendEmails();
            }}
          >
            Send emails
          </Button>
        </Box>
      ) : (
        <Text>No emails drafted at this time</Text>
      )}
    </Box>
  );
}

export default function EmailsPage() {
  return (
    <EmailManagementProvider>
      <EmailsInnerPage />
    </EmailManagementProvider>
  );
}
