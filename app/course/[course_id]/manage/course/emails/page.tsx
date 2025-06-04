"use client";
import { EmailDistributionItem, EmailDistributionList } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Collapsible, Field, Fieldset, Flex, Heading, Input, Skeleton, Textarea } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { Select } from "chakra-react-select";
import { TextCursorInput } from "lucide-react";
import MemberList from "./memberlist";
import { useState } from "react";

export default function EmailPage() {
  const { data: emailLists } = useList<EmailDistributionList>({
    resource: "email_distribution_list",
    meta: {
      select: "*"
    }
  });
  const [distributionList, setDistributionList] = useState<EmailDistributionList | null>(null);
  const [subjectLine, setSubjectLine] = useState<string>("");
  const [body, setBody] = useState<string>("");

  if (!emailLists) {
    return <Skeleton height="40" width="100%" />;
  }

  const sendEmails = () => {
    // TODO: send emails to everyone in the distribution list
  };

  return (
    <Box>
      <Heading>Send email to mailing list</Heading>
      <Fieldset.Root maxWidth="50%">
        <Fieldset.Content>
          <Field.Root>
            <Field.Label>Select mailing list</Field.Label>
            <Select
              onChange={(e) => setDistributionList(e?.value ?? null)}
              options={emailLists.data.map((list: EmailDistributionList) => ({ label: list.name, value: list }))}
            />
          </Field.Root>
          <MemberList list={distributionList} />
          <Field.Root>
            <Field.Label>Subject</Field.Label>
            <Input onChange={(e) => setSubjectLine(e.target.value)} />
          </Field.Root>
          <Field.Root>
            <Field.Label>Body</Field.Label>
            <Textarea onChange={(e) => setBody(e.target.value)} />
          </Field.Root>
          <Button onClick={() => sendEmails()}>Send emails</Button>
        </Fieldset.Content>
      </Fieldset.Root>
    </Box>
  );
}
