"use client";
import {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroupMembersWithGroup,
  ClassSection,
  Course,
  Submission,
  Tag,
  UserRole
} from "@/utils/supabase/DatabaseTypes";
import { Button, Field, Fieldset, Heading, Input, Textarea, Box, Flex, Text } from "@chakra-ui/react";
import { useList, useOne } from "@refinedev/core";
import { CreatableSelect, Select } from "chakra-react-select";
import { useEffect, useRef, useState } from "react";
import useTags from "@/hooks/useTags";
import { useParams } from "next/navigation";
import TagDisplay from "@/components/ui/tag";
import { EmailCreateDataWithoutId, EmailManagementProvider, useEmailManagement } from "./EmailManagementContext";
import { toaster, Toaster } from "@/components/ui/toaster";
import EmailPreviewAndSend from "./previewAndSend";
import { TZDate } from "@date-fns/tz";
import { addHours, addMinutes } from "date-fns";
import HistoryPage from "./historyPage";

/* types */
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
type SubmissionWithUser = Submission & {
  // emails for individual submissions
  user_roles: {
    users: {
      email: string;
      user_id: string;
    };
  } | null;
  // emails for group submissions
  assignment_groups: {
    assignment_groups_members: {
      user_roles: {
        users: {
          email: string;
          user_id: string;
        };
      };
    }[];
  } | null;
};
export type UserRoleWithUserDetails = UserRole & { users: { email: string; user_id: string } };

function EmailsInnerPage() {
  const { course_id } = useParams();
  const { emailsToCreate, addEmails, addBatch } = useEmailManagement();
  const [choice, setChoice] = useState<{ label: string; value: Audience | null }>();
  const [assignment, setAssignment] = useState<Assignment>();
  const [tag, setTag] = useState<Tag>();
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const tags = useTags();
  const [classSectionIds, setClassSectionIds] = useState<number[]>([]);
  const [ccList, setCcList] = useState<{ email: string; user_id: string }[]>([]);
  const [replyEmail, setReplyEmail] = useState<string>();
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
  /* Options for audience dropdown */
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

  /* Template variables to reference in subject/body that will be resolved with actual values */
  const templateVariables = [
    "assignment_name",
    "assignment_slug",
    "due_date",
    "assignment_url",
    "assignment_group_name",
    "course_name"
  ];

  /**
   * Only clear the form when the size of emails to create increases (someone drafts a new email)
   * Don't clear the form if instructor deletes another email draft midway through
   */
  const prevEmailsToCreateLength = useRef(emailsToCreate.length);
  useEffect(() => {
    if (emailsToCreate.length > prevEmailsToCreateLength.current) {
      setSubjectLine("");
      setBody("");
      setCcList([]);
      setChoice({ label: "", value: null });
      setTag(undefined);
      setAssignment(undefined);
      setReplyEmail(undefined);
    }
    prevEmailsToCreateLength.current = emailsToCreate.length;
  }, [emailsToCreate]);

  const { data: assignmentsData } = useList<Assignment>({
    resource: "assignments",
    meta: {
      select: "*"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  const { data: userRolesData } = useList<UserRoleWithUserDetails>({
    resource: "user_roles",
    meta: {
      select: "*, users!user_roles_user_id_fkey1(email, user_id)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  const users = userRolesData?.data.map((item) => item.users);

  const { data: submissionsData } = useList<SubmissionWithUser>({
    resource: "submissions",
    meta: {
      select: `
      *,
        user_roles!submissions_profile_id_fkey (
          users!user_roles_user_id_fkey1 (
            email, user_id
          )
        ),
        assignment_groups!submissions_assignment_group_id_fkey (
          assignment_groups_members!assignment_groups_members_assignment_group_id_fkey (
            user_roles!assignment_groups_members_profile_id_fkey1(
              users!user_roles_user_id_fkey1 (
                email, user_id
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

  const { data: classSectionsData } = useList<ClassSection>({
    resource: "class_sections",
    meta: {
      select: "*"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  const { data: course } = useOne<Course>({
    resource: "classes",
    id: course_id as string,
    queryOptions: {
      enabled: !!course_id
    }
  });

  const { data: dueDateExceptions } = useList<AssignmentDueDateException>({
    resource: "assignment_due_date_exceptions",
    meta: {
      select: "*"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  const { data: groups } = useList<AssignmentGroupMembersWithGroup>({
    resource: "assignment_groups_members",
    queryOptions: { enabled: !!assignment },
    meta: { select: "*, assignment_groups(*)" },
    pagination: { pageSize: 1000 },
    filters: [{ field: "assignment_id", operator: "eq", value: assignment?.id }]
  });

  const prepareMail = () => {
    const batch = addBatch({ subject: subjectLine, body: body, assignment_id: assignment?.id });
    const identities = getIdentitiesForChosenCategory() ?? [];
    const formatted_emails: EmailCreateDataWithoutId[] = [];
    identities.forEach((email) => {
      formatted_emails.push({
        batch_id: batch.id,
        to: email,
        why: whyLine(),
        subject: replaceTemplateVariables(batch.subject, email.user_id),
        body: replaceTemplateVariables(batch.body, email.user_id),
        cc_ids: ccList,
        reply_to: replyEmail
      });
    });
    addEmails(formatted_emails);
  };

  const replaceTemplateVariables = (text: string, user_id: string) => {
    // setup
    const profile_id = userRolesData?.data.find((role) => {
      return role.user_id === user_id;
    })?.private_profile_id;
    const group = assignment && profile_id ? userGroup(profile_id) : null;
    const baseUrl = window.location.origin;
    // get template variables
    const course_name = course?.data.name;
    const assignment_name = assignment?.title;
    const assignment_slug = assignment?.slug;
    const assignment_group_name = group?.name;
    const due_date = assignment && profile_id ? userDueDate(profile_id, assignment, group?.id) : null;
    const assignment_url = assignment ? `${baseUrl}/course/${course_id}/assignments/${assignment.id}` : null;
    // insert
    let inserted_text = text;
    if (course_name) {
      inserted_text = inserted_text.replace(/{course_name}/g, course_name);
    }
    if (assignment_name) {
      inserted_text = inserted_text.replace(/{assignment_name}/g, assignment_name);
    }
    if (assignment_slug) {
      inserted_text = inserted_text.replace(/{assignment_slug}/g, assignment_slug);
    }
    if (assignment_group_name) {
      inserted_text = inserted_text.replace(/{assignment_group_name}/g, assignment_group_name);
    }
    if (due_date) {
      inserted_text = inserted_text.replace(/{due_date}/g, due_date.toDateString());
    }
    if (assignment_url) {
      inserted_text = inserted_text.replace(/{assignment_url}/g, assignment_url);
    }
    return inserted_text;
  };

  const userDueDate = (profile_id: string, selected_assignment: Assignment, group_id?: number) => {
    if (!selected_assignment || !dueDateExceptions || !userRolesData) {
      return null;
    }
    const myExceptionsForAssignment = dueDateExceptions.data.filter((exception) => {
      return (
        (exception.student_id === profile_id || exception.assignment_group_id === group_id) &&
        exception.assignment_id === selected_assignment.id
      );
    });
    const hoursExtended = myExceptionsForAssignment.reduce((acc, curr) => acc + curr.hours, 0);
    const minutesExtended = myExceptionsForAssignment.reduce((acc, curr) => acc + curr.minutes, 0);
    const originalDueDate = new TZDate(selected_assignment.due_date);
    const dueDate = addMinutes(addHours(originalDueDate, hoursExtended), minutesExtended);
    return dueDate;
  };

  const userGroup = (user_id: string) => {
    const myProfileId = userRolesData?.data.find((role) => {
      return role.user_id === user_id;
    })?.private_profile_id;
    return groups?.data.find((groupmember) => {
      return groupmember.profile_id === myProfileId;
    })?.assignment_groups;
  };

  const whyLine = () => {
    switch (choice?.value) {
      case Audience.Submitted:
        return <>Submitted {assignment?.title}</>;
      case Audience.NotSubmitted:
        return <>Not submitted {assignment?.title}</>;
      case Audience.All:
        return <>Student, Grader, or Instructor</>;
      case Audience.CourseStaff:
        return <>Grader or Instructor</>;
      case Audience.Graders:
        return <>Grader</>;
      case Audience.Students:
        return <>Student</>;
      case Audience.Instructors:
        return <>Instructor</>;
      case Audience.Tag:
        return tag ? (
          <>
            Tagged with <TagDisplay tag={tag} />
          </>
        ) : (
          <></>
        );
      default:
        <></>;
    }
    return <></>;
  };

  const getIdentitiesForChosenCategory = () => {
    switch (choice?.value) {
      case Audience.Submitted:
        if (!assignment) {
          toaster.error({ title: "Failed to find assignment" });
          return;
        }
        return getAssignmentIdentities(assignment, "submitted");
      case Audience.NotSubmitted:
        if (!assignment) {
          toaster.error({ title: "Failed to find assignment" });
          return;
        }
        return getAssignmentIdentities(assignment, "not submitted");
      case Audience.All:
        return getGeneralIdentities(true, true, true);
      case Audience.CourseStaff:
        return getGeneralIdentities(false, true, true);
      case Audience.Students:
        return getGeneralIdentities(true, false, false);
      case Audience.Graders:
        return getGeneralIdentities(false, true, false);
      case Audience.Instructors:
        return getGeneralIdentities(false, false, true);
      case Audience.Tag:
        if (!tag) {
          toaster.error({ title: "Failed to find tag" });
          return;
        }
        return getTagIdentities(tag);
      default:
        return;
    }
  };

  const getAssignmentIdentities = (assignment: Assignment, submissionStatus: string) => {
    const submittedEmails =
      submissionsData?.data
        .filter((submission) => {
          return submission.assignment_id == assignment.id;
        })
        .map((submission) => {
          return submission.user_roles
            ? [submission.user_roles.users]
            : submission.assignment_groups
              ? submission.assignment_groups.assignment_groups_members.map((member) => {
                  return member.user_roles.users;
                })
              : [];
        })
        .reduce((prev, next) => {
          return prev.concat(next);
        }, []) ?? [];
    if (submissionStatus === "submitted") {
      return submittedEmails;
    } else if (submissionStatus === "not submitted") {
      const studentEmailsForClass =
        userRolesData?.data
          .filter((user) => {
            return user.role === "student";
          })
          .map((user) => {
            return user.users;
          }) ?? [];
      return studentEmailsForClass?.filter((email) => {
        return !submittedEmails
          .map((e) => {
            return e.user_id;
          })
          .includes(email.user_id);
      });
    }
    return [];
  };

  const getTagIdentities = (chosenTag: Tag) => {
    const profile_ids = tags.tags
      .filter((tag) => {
        return tag.color == chosenTag.color && tag.name == chosenTag.name && tag.visible === chosenTag.visible;
      })
      .map((tag) => {
        return tag.profile_id;
      });
    const ids =
      userRolesData?.data
        .filter((user) => {
          return profile_ids.includes(user.private_profile_id);
        })
        .map((user) => {
          return user.users;
        }) ?? [];
    return ids;
  };

  const getGeneralIdentities = (includeStudents: boolean, includeGraders: boolean, includeInstructors: boolean) => {
    const roles: string[] = [];
    if (includeStudents) {
      roles.push("student");
    }
    if (includeGraders) {
      roles.push("grader");
    }
    if (includeInstructors) {
      roles.push("instructor");
    }
    return (
      userRolesData?.data
        .filter((userRole) => {
          return (
            roles.includes(userRole.role) &&
            (userRole.class_section_id ||
              (userRole.class_section_id && classSectionIds.includes(userRole.class_section_id)))
          );
        })
        .map((userRole) => {
          return userRole.users;
        }) ?? []
    );
  };

  return (
    <Flex flexDirection={"column"} gap="10">
      <Flex gap="10" width="100%" wrap={{ base: "wrap", lg: "nowrap" }}>
        <Toaster />
        <Box width={{ base: "100%" }}>
          <Heading size="lg" mt="5" mb="5">
            Draft email
          </Heading>
          <Fieldset.Root>
            <Fieldset.Content>
              <Field.Root>
                <Field.Label>Template variables:</Field.Label>
                <Text fontSize="sm">
                  {templateVariables.map((val) => {
                    return `{${val}} `;
                  })}
                </Text>
                <Field.HelperText>
                  These variables can be referenced in brackets {"{}"} in the email subject or body, and will be filled
                  in with the proper values.
                </Field.HelperText>
              </Field.Root>
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
              {choice?.value &&
                [
                  Audience.All,
                  Audience.CourseStaff,
                  Audience.Graders,
                  Audience.Instructors,
                  Audience.Students
                ].includes(choice.value) && (
                  <Field.Root>
                    <Field.Label>Select Class Section(s)</Field.Label>
                    <Select
                      isMulti={true}
                      onChange={(e) => {
                        setClassSectionIds(
                          e.map((section) => {
                            return section.value;
                          })
                        );
                      }}
                      options={classSectionsData?.data.map((section) => {
                        return { label: section.name, value: section.id };
                      })}
                    />
                  </Field.Root>
                )}
              <Field.Root>
                <Field.Label>Cc</Field.Label>
                <CreatableSelect
                  value={ccList.map((cc) => ({ label: cc.email, value: cc.user_id }))}
                  onChange={(e) => setCcList(Array.from(e).map((elem) => ({ email: elem.label, user_id: elem.value })))}
                  isMulti={true}
                  options={users?.map((a) => ({ label: a.email, value: a.user_id }))}
                  placeholder="Select or type email addresses..."
                />
              </Field.Root>
              <Field.Root>
                <Field.Label>Reply email</Field.Label>
                <Input
                  value={replyEmail}
                  placeholder="Enter your email"
                  onChange={(e) => {
                    setReplyEmail(e.target.value);
                  }}
                />
                <Field.HelperText>
                  Replies will be redirected to this email. If none specified, will be sent to general pawtograder email
                </Field.HelperText>
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
        <EmailPreviewAndSend userRoles={userRolesData?.data} />
      </Flex>
      <HistoryPage userRoles={userRolesData?.data} course={course?.data} />
    </Flex>
  );
}

export default function EmailsPage() {
  return (
    <EmailManagementProvider>
      <EmailsInnerPage />
    </EmailManagementProvider>
  );
}
