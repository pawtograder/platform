"use client";
import {
  Assignment,
  AssignmentDueDateException,
  AssignmentGroupMembersWithGroup,
  ClassSection,
  Course,
  Submission,
  Tag,
  UserRole,
  LabSection
} from "@/utils/supabase/DatabaseTypes";
import { Button, Field, Fieldset, Heading, Input, Box, Flex, Text, Checkbox } from "@chakra-ui/react";
import { useList, useOne } from "@refinedev/core";
import { CreatableSelect, Select } from "chakra-react-select";
import { useEffect, useRef, useState } from "react";
import useTags from "@/hooks/useTags";
import { useParams } from "next/navigation";
import TagDisplay from "@/components/ui/tag";
import { EmailCreateDataWithoutId, EmailManagementProvider, useEmailManagement } from "./EmailManagementContext";
import { toaster, Toaster } from "@/components/ui/toaster";
import EmailPreviewAndSend from "./previewAndSend";
import { useTimeZone } from "@/lib/TimeZoneProvider";
import { TZDate } from "@date-fns/tz";
import { addHours, addMinutes } from "date-fns";
import HistoryPage from "./historyList";
import { formatInTimeZone } from "date-fns-tz";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { LuCheck } from "react-icons/lu";
import MdEditor from "@/components/ui/md-editor";
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

export type UserRoleWithUserDetails = UserRole & {
  users: {
    email: string;
    user_id: string;
  };
};

function EmailsInnerPage() {
  const { course_id } = useParams();
  const { emailsToCreate, addEmails, addBatch } = useEmailManagement();
  const [choice, setChoice] = useState<{ label: string; value: Audience | null }>();
  const [assignment, setAssignment] = useState<Assignment>();
  const [tag, setTag] = useState<Tag>();
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const tags = useTags();
  const { role: enrollment } = useClassProfiles();
  const timeZoneContext = useTimeZone();
  const [classSectionIds, setClassSectionIds] = useState<number[]>([]);
  const [labSectionIds, setLabSectionIds] = useState<number[]>([]);
  const [ccList, setCcList] = useState<{ email: string; user_id: string }[]>([]);
  const [replyEmail, setReplyEmail] = useState<string>();
  const [ccSelf, setCcSelf] = useState<boolean>(false);
  /* Tags unique by color and name */
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
  const audienceTemplateVariables: Record<Audience, string[]> = {
    [Audience.All]: ["course_name", "class_section", "lab_section"],
    [Audience.CourseStaff]: ["course_name", "class_section", "lab_section"],
    [Audience.Graders]: ["course_name", "class_section", "lab_section"],
    [Audience.Students]: ["course_name", "class_section", "lab_section"],
    [Audience.Instructors]: ["course_name", "class_section", "lab_section"],
    [Audience.Tag]: ["tag_name", "course_name", "class_section", "lab_section"],
    [Audience.Submitted]: [
      "assignment_name",
      "assignment_slug",
      "due_date",
      "assignment_url",
      "assignment_group_name",
      "course_name",
      "class_section",
      "lab_section"
    ],
    [Audience.NotSubmitted]: [
      "assignment_name",
      "assignment_slug",
      "due_date",
      "assignment_url",
      "assignment_group_name",
      "course_name",
      "class_section",
      "lab_section"
    ]
  };

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
      setClassSectionIds([]);
      setLabSectionIds([]);
    }
    prevEmailsToCreateLength.current = emailsToCreate.length;
  }, [emailsToCreate]);

  const { data: assignmentsData } = useList<Assignment>({
    resource: "assignments",
    meta: {
      select: "*"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: {
      pageSize: 1000
    }
  });

  const { data: userRolesData } = useList<UserRoleWithUserDetails>({
    resource: "user_roles",
    meta: {
      select: "*, users!user_roles_user_id_fkey1(email, user_id)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    pagination: {
      pageSize: 1000,
      current: 1
    }
  });

  const myEmail = userRolesData?.data.find((user) => user.user_id === enrollment.user_id)?.users.email;
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
    ],
    queryOptions: {
      enabled: !!course_id
    },
    pagination: {
      pageSize: 1000
    }
  });

  const { data: classSectionsData } = useList<ClassSection>({
    resource: "class_sections",
    meta: {
      select: "*"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    queryOptions: {
      enabled: !!course_id
    }
  });

  const { data: labSectionsData } = useList<LabSection>({
    resource: "lab_sections",
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    queryOptions: {
      enabled: !!course_id
    }
  });

  // Fetch lab section leaders separately
  const { data: labSectionLeadersData } = useList({
    resource: "lab_section_leaders",
    meta: {
      select: "lab_section_id, profile_id"
    },
    filters:
      labSectionsData?.data && labSectionsData.data.length > 0
        ? [
            {
              operator: "in",
              field: "lab_section_id",
              value: labSectionsData.data.map((section) => section.id)
            }
          ]
        : [],
    queryOptions: {
      enabled: !!labSectionsData?.data && labSectionsData.data.length > 0
    }
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
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    queryOptions: {
      enabled: !!course_id
    }
  });

  const { data: groups } = useList<AssignmentGroupMembersWithGroup>({
    resource: "assignment_groups_members",
    queryOptions: { enabled: !!assignment },
    meta: { select: "*, assignment_groups(*)" },
    pagination: { pageSize: 1000 },
    filters: [{ field: "assignment_id", operator: "eq", value: assignment?.id }]
  });

  const courseController = useCourseController();

  /**
   * Adds all mail to the "preview" section based on the current values in form.
   */
  const prepareMail = () => {
    const batch = addBatch({
      subject: subjectLine,
      body: body,
      assignment_id: assignment?.id,
      cc_ids: ccList,
      reply_to: replyEmail ?? myEmail ?? ""
    });
    const identities = getIdentitiesForChosenCategory() ?? [];
    const formatted_emails: EmailCreateDataWithoutId[] = [];
    identities.forEach((email) => {
      formatted_emails.push({
        batch_id: batch.id,
        to: email,
        why: whyLine(),
        subject: replaceTemplateVariables(subjectLine, email.user_id),
        body: replaceTemplateVariables(body, email.user_id),
        cc_ids: ccList,
        reply_to: replyEmail ?? myEmail ?? ""
      });
    });
    addEmails(formatted_emails);
  };

  /**
   * Replaces template variables in text string
   * @param text string to replace variables in.  Either subject or body.
   * @param user_id the user_id of the user that will receive this text
   * @returns text with {} template variables replaced with specific information
   */
  const replaceTemplateVariables = (text: string, user_id: string) => {
    const profile_id = userRolesData?.data.find((role) => {
      return role.user_id === user_id;
    })?.private_profile_id;
    const group = assignment && profile_id ? userGroup(profile_id) : null;
    const baseUrl = window.location.origin;
    const course_name = course?.data.name;
    const assignment_name = assignment?.title;
    const assignment_slug = assignment?.slug;
    const assignment_group_name = group?.name;
    const due_date = assignment && profile_id ? userDueDate(profile_id, group?.id) : null;
    const assignment_url = assignment ? `${baseUrl}/course/${course_id}/assignments/${assignment.id}` : null;
    const class_section = classSectionsData?.data.find(
      (section) => userRolesData?.data.find((user) => user.user_id === user_id)?.class_section_id === section.id
    );
    const lab_section = labSectionsData?.data.find(
      (section) => userRolesData?.data.find((user) => user.user_id === user_id)?.lab_section_id === section.id
    );
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
      // Use the user's preferred timezone from context, or fall back to course timezone
      const displayTimeZone = timeZoneContext?.timeZone || course?.data.time_zone || "America/New_York";
      inserted_text = inserted_text.replace(
        /{due_date}/g,
        `${formatInTimeZone(due_date, displayTimeZone, "MMM d, h:mm a zzz")}`
      );
    }
    if (assignment_url) {
      inserted_text = inserted_text.replace(/{assignment_url}/g, assignment_url);
    }
    if (tag) {
      inserted_text = inserted_text.replace(/{tag_name}/g, tag.name);
    }
    if (class_section) {
      inserted_text = inserted_text.replace(/{class_section}/g, class_section.name);
    }
    if (lab_section) {
      inserted_text = inserted_text.replace(/{lab_section}/g, lab_section.name);
    }
    return inserted_text;
  };

  /**
   * Determines user's due date for assignment considering both lab-based scheduling and due date exceptions
   * @param profile_id user's private profile id
   * @param group_id user's group (if they're in one)
   * @returns due date in timezone OR null if no assignment
   */
  const userDueDate = (profile_id: string, group_id?: number) => {
    if (!assignment || !dueDateExceptions || !userRolesData) {
      return null;
    }

    let effectiveDueDate: Date;

    // Calculate the lab-aware effective due date if CourseController is loaded
    if (courseController.labSectionMeetings.ready) {
      effectiveDueDate = courseController.calculateEffectiveDueDate(assignment, {
        studentPrivateProfileId: profile_id
      });
    } else {
      // Fallback to original due date if CourseController not loaded
      effectiveDueDate = new Date(assignment.due_date);
    }

    // Apply due date exceptions on top of the lab-aware due date
    const myExceptionsForAssignment = dueDateExceptions.data.filter((exception) => {
      return (
        (exception.student_id === profile_id || exception.assignment_group_id === group_id) &&
        exception.assignment_id === assignment.id
      );
    });
    const hoursExtended = myExceptionsForAssignment.reduce((acc, curr) => acc + curr.hours, 0);
    const minutesExtended = myExceptionsForAssignment.reduce((acc, curr) => acc + curr.minutes, 0);

    const finalDueDate = addMinutes(addHours(effectiveDueDate, hoursExtended), minutesExtended);
    return new TZDate(finalDueDate);
  };

  /**
   * Determines the group the user is in for the assignment in useState
   * @param user_id user
   * @returns group or null
   */
  const userGroup = (user_id: string) => {
    const myProfileId = userRolesData?.data.find((role) => {
      return role.user_id === user_id;
    })?.private_profile_id;
    return (
      groups?.data.find((groupmember) => {
        return groupmember.profile_id === myProfileId;
      })?.assignment_groups ?? null
    );
  };

  /**
   * Formats the reason why an email was created based on the audience chosen in the form.
   * Uses JSX instead of text because of tag display.
   * @returns JSX element
   */
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

  /**
   * Gets data about users that should receive a personalized email based on selected audience settings.
   * @returns `{user_id:string, email:string}[] or undefined`
   */
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

  /**
   * Get user data based on an assignment submission state.
   * @param assignment assignment to get users status on
   * @param submissionStatus submitted OR not submitted
   * @returns `{user_id:string, email:string}[]`
   */
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

  /**
   * Get user data based on those with the chosen tag
   * @param chosenTag tag to find users with
   * @returns `{user_id:string, email:string}[]`
   */
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

  /**
   * Get user data based on their role.
   * @returns `{user_id:string, email:string}[]`
   */
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
    // Get all lab section leader profile IDs for selected sections
    const labSectionLeaders =
      labSectionLeadersData?.data
        ?.filter((leader) => labSectionIds.includes(leader.lab_section_id))
        .map((leader) => leader.profile_id) || [];
    return (
      userRolesData?.data
        .filter((userRole) => {
          // Filter by role
          if (!roles.includes(userRole.role)) {
            return false;
          }

          // Filter by class section if any are selected
          if (classSectionIds.length > 0 && !classSectionIds.includes(userRole.class_section_id || 0)) {
            return false;
          }

          // Filter by lab section if any are selected
          if (
            labSectionIds.length > 0 &&
            !labSectionIds.includes(userRole.lab_section_id || 0) &&
            !labSectionLeaders?.includes(userRole.private_profile_id)
          ) {
            return false;
          }

          return true;
        })
        .map((userRole) => {
          return userRole.users;
        }) ?? []
    );
  };

  return (
    <Box>
      <Heading size="lg">Create and Send Emails</Heading>
      <Text fontSize="sm" color="gray.600" mb="2">
        Send emails to the entire class or to a subset. After preparing your message, you will be able to preview it
        before sending it.
      </Text>
      <Fieldset.Root size="lg" maxW="md">
        <Fieldset.Content>
          {/* Existing form fields... */}
          {choice?.value && (
            <Field.Root>
              <Field.Label>Template Variables</Field.Label>
              <Box p="3" borderWidth="1px" borderRadius="md" bg="gray.50">
                <Text fontSize="sm" color="gray.600" mb="2">
                  Available variables for the selected audience:
                </Text>
                <Flex wrap="wrap" gap="2">
                  {choice?.value &&
                    audienceTemplateVariables[choice.value].map((variable) => (
                      <Box key={variable} fontSize="xs" bg="blue.100" px="2" py="1" borderRadius="sm">
                        {`{${variable}}`}
                      </Box>
                    ))}
                </Flex>
              </Box>
            </Field.Root>
          )}

          <Field.Root>
            <Field.Label>Email To</Field.Label>
            <Select
              value={choice}
              onChange={(e) => {
                setChoice(e || undefined);
                setAssignment(undefined);
                setTag(undefined);
              }}
              options={options}
            />
          </Field.Root>

          {/* Existing conditional fields for assignment and tag... */}
          {choice && (choice.value === Audience.Submitted || choice.value === Audience.NotSubmitted) && (
            <Field.Root>
              <Field.Label>Assignment</Field.Label>
              <Select
                onChange={(e) => {
                  setAssignment(e?.value);
                }}
                options={assignmentsData?.data.map((assignment) => ({ label: assignment.title, value: assignment }))}
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
            [Audience.All, Audience.CourseStaff, Audience.Graders, Audience.Instructors, Audience.Students].includes(
              choice.value
            ) && (
              <>
                <Field.Root>
                  <Field.Label>Select class section(s)</Field.Label>
                  <Select
                    aria-label="Select class section(s)"
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
                    placeholder="Select class sections (optional)"
                  />
                </Field.Root>

                <Field.Root>
                  <Field.Label>Select lab section(s)</Field.Label>
                  <Select
                    isMulti={true}
                    aria-label="Select lab section(s)"
                    onChange={(e) => {
                      setLabSectionIds(
                        e.map((section) => {
                          return section.value;
                        })
                      );
                    }}
                    options={labSectionsData?.data.map((section) => {
                      // Get leaders for this section
                      const sectionLeaders =
                        labSectionLeadersData?.data
                          ?.filter((leader) => leader.lab_section_id === section.id)
                          .map((leader) => leader.profile_id) || [];
                      const leaderCount = sectionLeaders.length;
                      return {
                        label: `${section.name}${leaderCount > 0 ? ` (${leaderCount} facilitator${leaderCount > 1 ? "s" : ""})` : " (No facilitators)"}`,
                        value: section.id
                      };
                    })}
                    placeholder="Select lab sections (optional)"
                  />
                </Field.Root>
              </>
            )}

          {/* Existing cc email fields... */}
          <Field.Root>
            <Field.Label>Cc emails</Field.Label>
            <Checkbox.Root
              gap="4"
              alignItems="flex-start"
              checked={ccSelf}
              onCheckedChange={(e) => {
                if (e.checked && myEmail) {
                  setCcSelf(true);
                  setCcList([...ccList, { email: myEmail, user_id: enrollment.user_id }]);
                } else {
                  setCcSelf(false);
                  setCcList(ccList.filter((cc) => cc.email !== myEmail));
                }
              }}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control>
                <LuCheck />
              </Checkbox.Control>
              <Text fontSize="sm">Cc my email</Text>
            </Checkbox.Root>
            <CreatableSelect
              value={ccList.map((cc) => ({ label: cc.email, value: cc.user_id }))}
              aria-label="Select cc email addresses"
              onChange={(e) => {
                if (
                  myEmail &&
                  Array.from(e)
                    .map((item) => item.label)
                    .includes(myEmail)
                ) {
                  setCcSelf(true);
                } else {
                  setCcSelf(false);
                }
                setCcList(Array.from(e).map((elem) => ({ email: elem.label, user_id: elem.value })));
              }}
              isMulti={true}
              options={users?.map((a) => ({ label: a.email, value: a.user_id }))}
              placeholder="Select or type email addresses..."
            />
          </Field.Root>

          {/* Rest of existing form fields... */}
          <Field.Root>
            <Field.Label>Reply-to email</Field.Label>
            <Input
              value={replyEmail ?? ""}
              onChange={(e) => {
                setReplyEmail(e.target.value);
              }}
              placeholder={myEmail ?? ""}
            />
          </Field.Root>

          <Field.Root>
            <Field.Label>Subject</Field.Label>
            <Input
              value={subjectLine}
              onChange={(e) => {
                setSubjectLine(e.target.value);
              }}
            />
          </Field.Root>

          <Field.Root>
            <Field.Label>Body</Field.Label>
            <MdEditor
              uploadFolder="emails"
              textareaProps={{
                "aria-label": "Email body"
              }}
              value={body}
              onChange={(value) => {
                setBody(value ?? "");
              }}
              style={{ height: "200px" }}
            />
          </Field.Root>

          <Field.Root>
            <Button
              type="button"
              onClick={prepareMail}
              disabled={
                !choice ||
                !choice.value ||
                !subjectLine ||
                !body ||
                (choice.value === Audience.Tag && !tag) ||
                ((choice.value === Audience.Submitted || choice.value === Audience.NotSubmitted) && !assignment)
              }
            >
              Add to Preview
            </Button>
          </Field.Root>
        </Fieldset.Content>
      </Fieldset.Root>

      <EmailPreviewAndSend userRoles={userRolesData?.data} />
    </Box>
  );
}

export default function EmailsPage() {
  return (
    <Box p={4}>
      <EmailManagementProvider>
        <EmailsInnerPage />
        <HistoryPage />
        <Toaster />
      </EmailManagementProvider>
    </Box>
  );
}
