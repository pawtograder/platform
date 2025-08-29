import { createClient } from "@/utils/supabase/server";
import ClassManagementTable from "./ClassManagementTable";
import CreateClassModal from "./CreateClassModal";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { VStack, Flex, Heading, Text, HStack } from "@chakra-ui/react";
import Link from "next/link";

/**
 * Class management page for admins
 */
export default async function ClassesPage() {
  const supabase = await createClient();

  // Fetch all classes using the admin function
  const { data: classes } = await supabase.rpc("admin_get_classes");

  return (
    <VStack align="stretch" gap={6}>
      {/* Header */}
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">Class Management</Heading>
          <Text color="fg.muted">Create and manage all classes in the system</Text>
        </VStack>
        <HStack gap={3}>
          <Button asChild variant="outline">
            <Link href="/admin/import">
              <HStack gap={2}>
                <Plus size={16} />
                <Text>Import from SIS</Text>
              </HStack>
            </Link>
          </Button>
          <CreateClassModal>
            <Button>
              <HStack gap={2}>
                <Plus size={16} />
                <Text>Create Manually</Text>
              </HStack>
            </Button>
          </CreateClassModal>
        </HStack>
      </Flex>

      {/* Classes Table */}
      <ClassManagementTable classes={classes || []} />
    </VStack>
  );
}
