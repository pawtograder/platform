import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Course, EmailBatches, Emails } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Card, Collapsible, Flex, Heading, Separator } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { memo, useState } from "react";
import { UserRoleWithUserDetails } from "./page";

export default function HistoryPage({ course, userRoles }: { course?: Course; userRoles?: UserRoleWithUserDetails[] }) {
  const [displayNumber, setDisplayNumber] = useState<number>(25);

  const { data: batches } = useList<EmailBatches & { emails: Emails[] }>({
    resource: "email_batches",
    meta: {
      select: "*, emails!emails_batch_id_fkey(*)"
    },
    filters: [{ field: "class_id", operator: "eq", value: course?.id }],
    sorters: [{ field: "created_at", order: "desc" }],
    // liveMode: "auto",
    pagination: {
      pageSize: 1000
    },
    queryOptions: {
      enabled: !!course
    }
  });

  return (
    <Flex flexDir={"column"}>
      <Heading size="lg">History</Heading>
      {batches?.data.map((group, key) => {
        if (key >= displayNumber) {
          return <Box key={key}></Box>;
        }
        return (
          <Box key={key}>
            <EmailHistoryCard userRoles={userRoles} group={group} course={course} />{" "}
          </Box>
        );
      })}
      {batches?.data && displayNumber < batches.data.length && (
        <Button
          variant={"ghost"}
          onClick={() => {
            setDisplayNumber(displayNumber + 10);
          }}
        >
          {" "}
          Show more
        </Button>
      )}
    </Flex>
  );
}

export const EmailHistoryCard = memo(function EmailHistoryCard({
  userRoles,
  group
}: {
  userRoles?: UserRoleWithUserDetails[];
  group: EmailBatches & { emails: Emails[] };
  course?: Course;
}) {
  return (
    <Card.Root padding="2" size="sm" marginTop="2" marginBottom="2">
      <Collapsible.Root>
        <Collapsible.Trigger>
          <Card.Title>
            {group.emails.length} emails sent <TimeZoneAwareDate date={group.created_at} format="MMM d, h:mm a" />
          </Card.Title>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Card.Body>
            {group.emails.map((recipient, key) => {
              return (
                <Box padding="1" fontSize="sm" key={key}>
                  <Box>Subject: {recipient.subject ?? recipient.subject}</Box>
                  <Box>
                    To:{" "}
                    {
                      userRoles?.find((user) => {
                        return user.user_id === recipient.user_id;
                      })?.users.email
                    }
                  </Box>
                  <Box>Cc: {(recipient.cc_emails as { emails?: string[] })?.emails?.join(", ")}</Box>
                  <Box>Reply to: {recipient.reply_to}</Box>
                  <Box paddingBottom="2">Body: {recipient.body ?? recipient.body}</Box>
                  <Separator />
                </Box>
              );
            })}
          </Card.Body>
        </Collapsible.Content>
      </Collapsible.Root>
    </Card.Root>
  );
});
