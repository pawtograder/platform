"use client";
import {
  Assignment,
  EmailDistributionItem,
  EmailDistributionList,
  Tag,
  UserRole
} from "@/utils/supabase/DatabaseTypes";
import {
  Accordion,
  Button,
  Field,
  Fieldset,
  Text,
  Heading,
  Input,
  Skeleton,
  Tabs,
  Textarea,
  Box
} from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { Dispatch, SetStateAction, useEffect, useState } from "react";
import useTags from "@/hooks/useTags";
import { useParams } from "next/navigation";
import TagDisplay from "@/components/ui/tag";

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

export default function Page() {
  const { course_id } = useParams();
  const [choice, setChoice] = useState<Audience>();
  const [assignment, setAssignment] = useState<Assignment>();
  const [tag, setTag] = useState<Tag>();
  const [group, setGroup] = useState();
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");

  const options = [
    { label: "Students who have submitted an assignment", value: Audience.Submitted },
    { label: "Students who have not submitted an assignment", value: Audience.NotSubmitted },
    { label: "Students, Instructors, and Graders", value: Audience.All },
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

  return (
    <>
      <Heading size="lg" mt="5" mb="5">
        Draft email
      </Heading>
      <Fieldset.Root maxWidth="2xl">
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
                  ),
                  MultiValue: ({ data, ...props }) => (
                    <Box key={data.value.id} {...props.innerProps} p="4px 8px" cursor="pointer">
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
          <Button>
            Prepare mail 
          </Button>
          <Field.HelperText>
            You&apos;ll be able to review the email before it is sent
          </Field.HelperText>
          </Field.Root>
        </Fieldset.Content>
        
      </Fieldset.Root>
    </>
  );
}

export function EmailPage() {
  const [emails, setEmails] = useState<string[]>([]);
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");
  const [value, setValue] = useState<string | null>("assignment");
  useEffect(() => {
    setEmails([]);
  }, [value]);

  const sendEmails = () => {
    console.log(subjectLine);
    console.log(body);
    // TODO: send emails to everyone in the distribution list
  };

  return (
    <Box>
      <Heading>Send email to mailing list</Heading>
      <Fieldset.Root maxWidth="50%">
        <Tabs.Root value={value} onValueChange={(e) => setValue(e.value)} variant="enclosed" fitted>
          <Tabs.List>
            <Tabs.Trigger value="general">General</Tabs.Trigger>
            <Tabs.Trigger value="assignment">Assignment Status</Tabs.Trigger>
            <Tabs.Trigger value="tag">Tag</Tabs.Trigger>
            <Tabs.Trigger value="custom">Custom List</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="general">
            <GeneralForm setEmails={setEmails} />
          </Tabs.Content>
          <Tabs.Content value="assignment">
            <AssignmentForm setEmails={setEmails} />
          </Tabs.Content>
          <Tabs.Content value="tag">
            <TagForm setEmails={setEmails} />
          </Tabs.Content>
          <Tabs.Content value="custom">
            <CustomForm setEmails={setEmails} />
          </Tabs.Content>
        </Tabs.Root>
        <Fieldset.Content>
          <Field.Root>
            {" "}
            <Accordion.Root collapsible paddingY="3">
              <Accordion.Item key={1} value={"Mailing list members"}>
                <Accordion.ItemTrigger>
                  <Field.Label>Mailing list members</Field.Label>
                </Accordion.ItemTrigger>
                <Accordion.ItemContent>
                  <Accordion.ItemBody>
                    {emails.map((email, key) => {
                      return (
                        <Text key={key} fontSize="sm">
                          {email}
                        </Text>
                      );
                    })}
                  </Accordion.ItemBody>
                </Accordion.ItemContent>
              </Accordion.Item>
            </Accordion.Root>
          </Field.Root>
          <Field.Root>
            <Field.Label>Subject</Field.Label>
            <Input onChange={(e) => setSubjectLine(e.target.value)} />
          </Field.Root>
          <Field.Root>
            <Field.Label>Body</Field.Label>
            <Textarea onChange={(e) => setBody(e.target.value)} />
          </Field.Root>
          <Button onClick={() => sendEmails()} disabled={emails.length === 0}>
            Send email
          </Button>
        </Fieldset.Content>
      </Fieldset.Root>
    </Box>
  );
}

function GeneralForm({ setEmails }: { setEmails: Dispatch<SetStateAction<string[]>> }) {
  const [audience, setAudience] = useState<string | null>();
  const { data: userData } = useList({
    resource: "user_roles",
    meta: {
      select: "*, users!user_roles_user_id_fkey1(name, email)"
    }
  });
  const studentEmails =
    userData?.data
      .filter((data) => {
        return data.role == "student";
      })
      .map((data) => {
        return data.users.email;
      }) ?? [];
  const graderEmails =
    userData?.data
      .filter((data) => {
        return data.role == "grader";
      })
      .map((data) => {
        return data.users.email;
      }) ?? [];
  const instructorEmails =
    userData?.data
      .filter((data) => {
        return data.role == "instructor";
      })
      .map((data) => {
        return data.users.email;
      }) ?? [];

  useEffect(() => {
    if (audience == "students") {
      setEmails(studentEmails);
    } else if (audience == "graders") {
      setEmails(graderEmails);
    } else if (audience == "instructors") {
      setEmails(instructorEmails);
    } else if (audience == "everyone") {
      setEmails(studentEmails.concat(graderEmails).concat(instructorEmails));
    }
  }, [audience]);

  return (
    <>
      <Fieldset.Root>
        <Field.Root>
          <Field.Label>Select audience</Field.Label>
          <Select
            onChange={(e) => setAudience(e?.value ?? null)}
            options={[
              { label: "Students in this class", value: "students" },
              { label: "Graders for this class", value: "graders" },
              { label: "Instructors for this class", value: "instructors" },
              { label: "Everyone (students, graders, and instructors)", value: "everyone" }
            ]}
          />
        </Field.Root>
        <Field.Root></Field.Root>
      </Fieldset.Root>
    </>
  );
}

function TagForm({ setEmails }: { setEmails: Dispatch<SetStateAction<string[]>> }) {
  const [tag, setTag] = useState<Tag | null>();
  const tags = useTags();

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

  return (
    <>
      <Fieldset.Root>
        <Field.Root>
          <Field.Label>Select tag</Field.Label>
          <Select
            onChange={(e) => setTag(e?.value ?? null)}
            options={uniqueTags.map((t: Tag) => ({ label: t.name, value: t }))}
          />
        </Field.Root>
        <Field.Root></Field.Root>
      </Fieldset.Root>
    </>
  );
}

type SubmissionEmails = {
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

type UserRoleWithUser = UserRole & {
  users: {
    email: string;
  };
};

function AssignmentForm({ setEmails }: { setEmails: Dispatch<SetStateAction<string[]>> }) {
  const [assignment, setAssignment] = useState<Assignment | null>();
  const [who, setWho] = useState<string | null>();
  const { data: assignmentsData } = useList<Assignment>({
    resource: "assignments",
    meta: {
      select: "*"
    }
  });
  const { data: submissions } = useList<SubmissionEmails>({
    resource: "submissions",
    meta: {
      select: `
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
      { field: "assignment_id", operator: "eq", value: assignment?.id },
      { field: "is_active", operator: "eq", value: true }
    ],
    queryOptions: {
      enabled: !!assignment
    }
  });
  console.log(submissions);
  const { data: userData } = useList<UserRoleWithUser>({
    resource: "user_roles",
    meta: {
      select: "*, users!user_roles_user_id_fkey1(name, email)"
    }
  });
  const allStudentEmails =
    userData?.data
      .filter((user) => {
        return user.role == "student";
      })
      .map((user) => {
        return user.users.email;
      }) ?? [];
  const submittedEmails =
    submissions?.data
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
  useEffect(() => {
    if (who == "submitted") {
      setEmails(submittedEmails);
    } else {
      setEmails(
        allStudentEmails?.filter((email) => {
          return !submittedEmails.includes(email);
        }) ?? []
      );
    }
  }, [assignment, who]);

  if (!assignmentsData) {
    return <Skeleton height="40" width="100%" />;
  }
  return (
    <>
      <Fieldset.Root>
        <Field.Root>
          <Field.Label>Select assignment</Field.Label>
          <Select
            onChange={(e) => setAssignment(e?.value ?? null)}
            options={assignmentsData.data.map((a: Assignment) => ({ label: a.title, value: a }))}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label>Who from assignment</Field.Label>
          <Select
            onChange={(e) => setWho(e?.value ?? null)}
            options={[
              { label: "Students who have submitted", value: "submitted" },
              { label: "Students who have not submitted", value: "not submitted" }
            ]}
          />
        </Field.Root>
      </Fieldset.Root>
    </>
  );
}

function CustomForm({ setEmails }: { setEmails: Dispatch<SetStateAction<string[]>> }) {
  const [distributionList, setDistributionList] = useState<EmailDistributionList | null>(null);
  const { data: customEmailLists } = useList<EmailDistributionList>({
    resource: "email_distribution_list",
    meta: {
      select: "*"
    }
  });
  const { data: emailItems } = useList<EmailDistributionItem>({
    resource: "email_distribution_items",
    meta: {
      select: "*"
    },
    filters: [{ field: "email_distribution_list_id", operator: "eq", value: distributionList?.id }],
    queryOptions: {
      enabled: !!distributionList
    }
  });

  useEffect(() => {
    setEmails(
      emailItems?.data.map((item) => {
        return item.email.toString();
      }) ?? []
    );
  }, [emailItems]);

  if (!customEmailLists) {
    return <Skeleton height="40" width="100%" />;
  }

  return (
    <Fieldset.Root>
      <Field.Root>
        <Field.Label>Select your custom list</Field.Label>
        <Select
          onChange={(e) => setDistributionList(e?.value ?? null)}
          options={customEmailLists.data.map((list: EmailDistributionList) => ({ label: list.name, value: list }))}
        />
      </Field.Root>
      <Field.Root></Field.Root>
    </Fieldset.Root>
  );
}
