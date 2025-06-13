import { EmailCreateData, useEmailManagement } from "./EmailManagementContext";
import { Submission, Tag, UserRole } from "@/utils/supabase/DatabaseTypes";
import { useList } from "@refinedev/core";
import TagDisplay from "@/components/ui/tag";
import { Box, Button, Card, Editable, Flex, Heading, Text } from "@chakra-ui/react";
import { IoMdClose } from "react-icons/io";
import { useParams } from "next/navigation";

export default function EmailPreviewAndSend({ tags }: { tags: Tag[] }) {
  const { course_id } = useParams();
  const { emailsToCreate, removeEmail, updateEmailField } = useEmailManagement();
  type UserRoleWithEmail = UserRole & { users: { email: string } };

  const { data: userRolesData } = useList<UserRoleWithEmail>({
    resource: "user_roles",
    meta: {
      select: "*, users!user_roles_user_id_fkey1(email)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }]
  });

  type SubmissionEmail = Submission & {
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

  const { data: submissions } = useList<SubmissionEmail>({
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
      await sendSingleEmail(emailToCreate);
    });
  };

  const sendSingleEmail = async (emailToCreate: EmailCreateData) => {
    const emails = getEmailsToSendTo(emailToCreate);
    console.log(emails);
  };

  /**
   * For a single drafted email spec, determines the list of emails the conditions
   * apply to.  This function will be called once per drafted email (EmailCreateData)
   * when the "send" button is pressed.
   */
  const getEmailsToSendTo = (emailToCreate: EmailCreateData) => {
    const recipients: string[] = [];
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
        submittedEmails.forEach((email) => recipients.push(email));
      } else if (emailToCreate.audience.submissionType === "not submitted") {
        const studentEmailsForClass = userRolesData?.data
          .filter((user) => {
            return user.role === "student";
          })
          .map((user) => {
            return user.users.email;
          });
        studentEmailsForClass
          ?.filter((email) => {
            return !submittedEmails.includes(email);
          })
          .forEach((email) => {
            recipients.push(email);
          });
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
      emails?.forEach((email) => recipients.push(email));
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
      userRolesData?.data
        .filter((userRole) => {
          return roles.includes(userRole.role);
        })
        .map((userRole) => {
          return userRole.users.email;
        })
        .forEach((email) => recipients.push(email));
    }
    return recipients;
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
                np
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
                  <Text>
                    Cc:{" "}
                    {email.cc_emails.map((cc) => {
                      return cc + " ";
                    })}
                  </Text>
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
