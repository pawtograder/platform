import { Course, EmailRecipients } from "@/utils/supabase/DatabaseTypes";
import { Button, Card, Collapsible, Flex, Separator, Box, Heading } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useParams } from "next/navigation";
import { useState } from "react";
import { UserRoleWithUserDetails } from "./page";
import { formatInTimeZone } from "date-fns-tz";
import { TZDate } from "@date-fns/tz";
import _ from "lodash";

export default function HistoryPage({ course, userRoles }: { course?: Course; userRoles?: UserRoleWithUserDetails[] }) {
  const { course_id } = useParams();
  const [displayNumber, setDisplayNumber] = useState<number>(10);

  const { data: emails } = useList<EmailRecipients>({
    resource: "email_recipients",
    meta: {
      select: "*"
    },
    filters: [{ field: "class_id", operator: "eq", value: course_id }],
    sorters: [{ field: "created_at", order: "desc" }],
    liveMode: "auto"
  });

  const createTimeKey = (dateString: string, bucketMinutes: number = 5) => {
    const date = new Date(dateString);
    const minutes = date.getMinutes();
    const bucketedMinutes = Math.floor(minutes / bucketMinutes) * bucketMinutes;
    const bucketedDate = new Date(date);
    bucketedDate.setMinutes(bucketedMinutes, 0, 0);
    const timezoneSuffix = bucketedDate.toISOString().substring(23);
    return bucketedDate.toISOString().slice(0, 16) + timezoneSuffix;
  };

  const groupedByTime: _.Dictionary<EmailRecipients[]> = _.groupBy(
    emails?.data || [],
    (email) => createTimeKey(email.created_at, 5) // 5-minute buckets
  );

  const timeGroupsArray = Object.entries(groupedByTime).map(([timeKey, emailGroup]) => ({
    timeKey,
    emails: emailGroup,
    count: emailGroup.length
  }));

  return (
    <Flex flexDir={"column"}>
      <Heading size="lg">History</Heading>
      {timeGroupsArray.map((group, key) => {
        if (key >= displayNumber) {
          return <Box key={key}></Box>;
        }
        return (
          <Card.Root padding="2" size="sm" key={key} marginTop="2" marginBottom="2">
            <Collapsible.Root>
              <Collapsible.Trigger>
                <Card.Title>
                  {group.count} emails sent{" "}
                  {formatInTimeZone(
                    new TZDate(group.timeKey, course?.time_zone ?? "America/New_York"),
                    course?.time_zone || "America/New_York",
                    "MMM d h:mm aaa"
                  )}{" "}
                  ({course?.time_zone})
                </Card.Title>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <Card.Body>
                  {group.emails.map((recipient, key) => {
                    return (
                      <Box key={key} padding="1" fontSize="sm">
                        <Box>Subject: {recipient.subject ?? recipient.subject}</Box>
                        <Box>
                          To:{" "}
                          {
                            userRoles?.find((user) => {
                              return user.user_id === recipient.user_id;
                            })?.users.email
                          }
                        </Box>
                        <Box>
                          Cc:{" "}
                          {typeof recipient.cc_emails === "object" &&
                            recipient.cc_emails !== null &&
                            !Array.isArray(recipient.cc_emails) &&
                            "emails" in recipient.cc_emails &&
                            (recipient.cc_emails as { emails: string[] }).emails.map((email) => {
                              return email + " ";
                            })}
                        </Box>
                        <Box>Reply to: {recipient.reply_to ?? "General pawtograder email"}</Box>

                        <Box>Body: {recipient.body ?? recipient.body}</Box>
                        <Separator />
                      </Box>
                    );
                  })}
                </Card.Body>
              </Collapsible.Content>
            </Collapsible.Root>
          </Card.Root>
        );
      })}
      {displayNumber < timeGroupsArray.length && (
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
