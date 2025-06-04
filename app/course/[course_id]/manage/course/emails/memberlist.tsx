import { useClassProfiles } from "@/hooks/useClassProfiles";
import { EmailDistributionItem, EmailDistributionList } from "@/utils/supabase/DatabaseTypes";
import { Box, Collapsible, Field, Text } from "@chakra-ui/react";
import { useList } from "@refinedev/core";

export default function MemberList({ list }: { list: EmailDistributionList | null }) {
  if (!list) {
    return;
  }
  const { data: members } = useList<EmailDistributionItem>({
    resource: "email_distribution_item",
    filters: [
      {
        field: "email_distribution_list_id",
        operator: "eq",
        value: list.id
      }
    ]
  });

  const { profiles } = useClassProfiles();
  return (
    <Field.Root>
      {" "}
      <Collapsible.Root unmountOnExit>
        <Collapsible.Trigger paddingY="3">
          <Field.Label>Mailing list members</Field.Label>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Box padding="4" borderWidth="1px">
            {members &&
              members.data.map((member, key) => {
                return <Text key={key}>{profiles.find((profile) => profile.id == member.profile_id)?.name}</Text>;
              })}
          </Box>
        </Collapsible.Content>
      </Collapsible.Root>
    </Field.Root>
  );
}
