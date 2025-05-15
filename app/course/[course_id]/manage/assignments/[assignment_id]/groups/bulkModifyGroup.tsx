import { toaster } from "@/components/ui/toaster";
import {
  Assignment,
  AssignmentGroupWithMembersInvitationsAndJoinRequests,
  UserProfile
} from "@/utils/supabase/DatabaseTypes";
import {
  Button,
  Dialog,
  DialogActionTrigger,
  Field,
  FieldRoot,
  Flex,
  HStack,
  Input,
  Portal,
  Separator,
  Text,
  VStack
} from "@chakra-ui/react";
import { MultiValue, Select } from "chakra-react-select";
import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useInvalidate } from "@refinedev/core";
import { useUngroupedStudentProfiles } from "./bulkCreateGroupModal";
import { useCourseController } from "@/hooks/useCourseController";

export default function BulkModifyGroup({
  groups,
  assignment,
}: {
  groups: AssignmentGroupWithMembersInvitationsAndJoinRequests[];
  assignment: Assignment;
}) {
  const supabase = createClient();
  const invalidate = useInvalidate();

  const [selectedMembers, setSelectedMembers] = useState<
    MultiValue<{
      label: string | null;
      value: string;
    }>
  >([]);

  return (
    <Dialog.Root key={"center"} placement={"center"} motionPreset="slide-in-bottom">
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          Bulk Modify Group
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Bulk Modify Group</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Flex flexDir="column" gap="15px">
                <Flex flexDir="column">
                  <Field.Root>
                    <Field.Label>Find group by name</Field.Label>
                  </Field.Root>
                  <Text>OR</Text>
                  <Field.Root>
                    <Field.Label>Find group by member</Field.Label>
                  </Field.Root>
                </Flex>
                <Flex flexDir="column" justifyContent={"left"}>
                  <Text fontWeight="700">Selected group details: </Text>
                  <Text>Name: </Text>
                  <Text>Current members: </Text>
                  <Text>Has room for ___ more</Text>
                </Flex>

                <Separator></Separator>

                <Field.Root>
                  <Field.Label>Select students to move to this group</Field.Label>
                </Field.Root>
              </Flex>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline" colorPalette={"gray"}>
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <DialogActionTrigger>
                <Button colorPalette={"green"}>Save</Button>
              </DialogActionTrigger>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
