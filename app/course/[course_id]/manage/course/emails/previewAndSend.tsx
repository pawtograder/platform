import {
  AssignmentEmailInfo,
  EmailCreateData,
  GeneralEmailInfo,
  TagEmailInfo,
  useEmailManagement
} from "./EmailManagementContext";
import { Submission, Tag, UserRole } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useList } from "@refinedev/core";
import TagDisplay from "@/components/ui/tag";
import { Box, Button, Card, Editable, Flex, Heading, Text } from "@chakra-ui/react";
import { IoMdClose } from "react-icons/io";
import { useParams } from "next/navigation";
import { toaster } from "@/components/ui/toaster";

export default function EmailPreviewAndSend({ tags }: { tags: Tag[] }) {
  const { course_id } = useParams();
  const { emailsToCreate, removeEmail, updateEmailField } = useEmailManagement();
  type UserRoleWithUserId = UserRole & { users: { user_id: string } };
  const { mutateAsync } = useCreate();

  const { data: userRolesData } = useList<UserRoleWithUserId>({
    resource: "user_roles",
    meta: {
      select: "*, users!user_roles_user_id_fkey1(user_id)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  type SubmissionEmail = Submission & {
    // emails for individual submissions
    user_roles: {
      users: {
        user_id: string;
      };
    } | null;
    // emails for group submissions
    assignment_groups: {
      assignment_groups_members: {
        user_roles: {
          users: {
            user_id: string;
          };
        };
      }[];
    } | null;
  };

  const { data: submissions } = useList<SubmissionEmail>({
    resource: "submissions",
    meta: {
      select: `
      *,
        user_roles!submissions_profile_id_fkey (
          users!user_roles_user_id_fkey1 (
            user_id
          )
        ),
        assignment_groups!submissions_assignment_group_id_fkey (
          assignment_groups_members!assignment_groups_members_assignment_group_id_fkey (
              user_roles!assignment_groups_members_profile_id_fkey1(
                users!user_roles_user_id_fkey1 (
                  user_id
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

  /**
   * Translates a drafted email (stored in EmailCreateData) to a JSX element that details
   * who the email will be sent to via attribute.  The exact emails will depend on the state of
   * the data when "send" is pressed, e.g. who has submitted versus not in that moment.
   * Used in email draft previews.
   */
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
      await sendSingleEmail(emailToCreate)
        .then(() => {
          toaster.success({
            title: `Successfully sent email \"${emailToCreate.subject}\"`
          });
        })
        .catch((error) => {
          toaster.error({ title: `Error sending email ${emailToCreate.subject}`, description: error.message });
        });
      removeEmail(emailToCreate.id);
    });
  };

  const sendSingleEmail = async (emailToCreate: EmailCreateData) => {
    const ids = getIdsToSendTo(emailToCreate);
    const { data: createdEmail } = await mutateAsync({
      resource: "emails",
      values: {
        class_id: course_id,
        subject: emailToCreate.subject,
        body: emailToCreate.body
      }
    });
    ids.forEach(async (id) => {
      await mutateAsync({
        resource: "email_recipients",
        values: {
          user_id: id,
          class_id: course_id,
          email_id: createdEmail.id
        }
      });
    });
  };

  /**
   * For a single drafted email spec, determines the list of emails the conditions
   * apply to.  This function will be called once per drafted email (EmailCreateData)
   * when the "send" button is pressed.
   */
  const getIdsToSendTo = (emailToCreate: EmailCreateData) => {
    if (emailToCreate.audience.type === "assignment") {
      return getAssignmentIds(emailToCreate.audience);
    } else if (emailToCreate.audience.type === "tag") {
      return getTagIds(emailToCreate.audience);
    } else if (emailToCreate.audience.type === "general") {
      return getGeneralIds(emailToCreate.audience);
    }
    return [];
  };

  const getAssignmentIds = (audience: AssignmentEmailInfo) => {
    const assignment = audience.assignment;
    const submittedIds =
      submissions?.data
        .filter((submission) => {
          return submission.assignment_id == assignment.id;
        })
        .map((submission) => {
          return submission.user_roles
            ? [submission.user_roles.users.user_id]
            : submission.assignment_groups
              ? submission.assignment_groups.assignment_groups_members.map((member) => {
                  return member.user_roles.users.user_id.toString();
                })
              : [];
        })
        .reduce((prev, next) => {
          return prev.concat(next);
        }, []) ?? [];
    if (audience.submissionType === "submitted") {
      return submittedIds;
    } else if (audience.submissionType === "not submitted") {
      const studentIdsForClass =
        userRolesData?.data
          .filter((user) => {
            return user.role === "student";
          })
          .map((user) => {
            return user.users.user_id;
          }) ?? [];
      return studentIdsForClass?.filter((id) => {
        return !submittedIds.includes(id);
      });
    }
    return [];
  };

  const getTagIds = (audience: TagEmailInfo) => {
    const chosenTag = audience.tag;
    const profile_ids = tags
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
          return user.users.user_id;
        }) ?? [];
    return ids;
  };

  const getGeneralIds = (audience: GeneralEmailInfo) => {
    const roles: string[] = [];
    if (audience.includeGraders) {
      roles.push("grader");
    }
    if (audience.includeInstructors) {
      roles.push("instructor");
    }
    if (audience.includeStudents) {
      roles.push("student");
    }
    return (
      userRolesData?.data
        .filter((userRole) => {
          return roles.includes(userRole.role);
        })
        .map((userRole) => {
          return userRole.users.user_id;
        }) ?? []
    );
  };

  return (
    <Box width={{ base: "100%" }}>
      <Heading size="lg" mt="5" mb="5">
        Preview and send
      </Heading>
      {emailsToCreate.length > 0 ? (
        <Box spaceY="4">
          {emailsToCreate.map((email, key) => {
            return (
              <Card.Root key={key} padding="2" mt="5" size="sm">
                <Flex justifyContent={"space-between"}>
                  <Card.Title>
                    <Flex alignItems="center">
                      Subject:
                      <Editable.Root
                        value={email.subject}
                        onValueChange={(e) => {
                          {
                            if (email.id) {
                              updateEmailField(email.id, "subject", e.value);
                            }
                          }
                        }}
                      >
                        <Editable.Preview />
                        <Editable.Input />
                      </Editable.Root>
                    </Flex>
                  </Card.Title>
                  <Text
                    onClick={() => {
                      if (email.id) {
                        removeEmail(email.id);
                      }
                    }}
                  >
                    <IoMdClose />
                  </Text>
                </Flex>
                <Flex flexDir={"column"} fontSize="sm">
                  <Text>To: {emailToAudienceText(email)}</Text>
                  <Flex alignItems="center">
                    Body:
                    <Editable.Root
                      value={email.body}
                      onValueChange={(e) => {
                        {
                          if (email.id) {
                            updateEmailField(email.id, "body", e.value);
                          }
                        }
                      }}
                    >
                      <Editable.Preview />
                      <Editable.Input />
                    </Editable.Root>
                  </Flex>
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
