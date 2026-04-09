export const dynamic = "force-dynamic";

import { AdminDashboardSkeleton } from "@/components/ui/route-loading-skeleton";
import { Button } from "@/components/ui/button";
import { Flex, Heading, HStack, Text, VStack } from "@chakra-ui/react";
import { Plus } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { AdminDashboardContent } from "./AdminDashboardContent";

/**
 * Admin dashboard: header streams immediately; metrics load inside Suspense.
 */
export default function AdminPage() {
  return (
    <VStack align="stretch" gap={6}>
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">Dashboard</Heading>
          <Text color="fg.muted">Overview of your platform</Text>
        </VStack>
        <Button asChild>
          <Link href="/admin/classes">
            <HStack gap={2}>
              <Plus size={16} />
              <Text>New Class</Text>
            </HStack>
          </Link>
        </Button>
      </Flex>

      <Suspense fallback={<AdminDashboardSkeleton />}>
        <AdminDashboardContent />
      </Suspense>
    </VStack>
  );
}
