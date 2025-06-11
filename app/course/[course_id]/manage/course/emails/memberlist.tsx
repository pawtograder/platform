import { useClassProfiles } from "@/hooks/useClassProfiles";
import { EmailDistributionItem, EmailDistributionList } from "@/utils/supabase/DatabaseTypes";
import { Accordion, Field, Text } from "@chakra-ui/react";
import { CrudFilter, useList } from "@refinedev/core";

export default function MemberList({ list }: { list: EmailDistributionList | null }) {
  const filters: CrudFilter[] = [];
  if (list) {
    filters.push({
      field: "email_distribution_list_id",
      operator: "eq",
      value: list.id
    });
  }

  const { data: members } = useList<EmailDistributionItem>({
    resource: "email_distribution_item",
    filters: [...filters]
  });

  const { profiles } = useClassProfiles();
  return (
    <Field.Root>
      {" "}
      <Accordion.Root collapsible paddingY="3">
        <Accordion.Item key={1} value={"Mailing list members"}>
          <Accordion.ItemTrigger>
            <Field.Label>Mailing list members</Field.Label>
          </Accordion.ItemTrigger>
          <Accordion.ItemContent>
            <Accordion.ItemBody>
              {members &&
                members.data.map((member, key) => {
                  return (
                    <Text key={key} fontSize="sm">
                      {profiles.find((profile) => profile.id == member.profile_id)?.name}
                    </Text>
                  );
                })}
            </Accordion.ItemBody>
          </Accordion.ItemContent>
        </Accordion.Item>
      </Accordion.Root>
    </Field.Root>
  );
}
