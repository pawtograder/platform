"use client";

import { Button } from "@/components/ui/button";
import { toaster, Toaster } from "@/components/ui/toaster";
import { enrollmentSyncCanvas } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { ClassSection } from "@/utils/supabase/DatabaseTypes";
import { Box, Container, Heading, List, Text } from "@chakra-ui/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import EnrollmentsTable from "./enrollmentsTable";

export default function EnrollmentsPage() {
  const { course_id } = useParams();
  const [isSyncing, setIsSyncing] = useState(false);
  const [sections, setSections] = useState<ClassSection[]>([]);
  const supabase = createClient();

  useEffect(() => {
    const fetchSections = async () => {
      const { data } = await supabase
        .from("class_sections")
        .select("*")
        .eq("class_id", parseInt(course_id as string));
      setSections(data || []);
    };
    fetchSections();
  }, [course_id, supabase]);

  return (
    <Container>
      <Heading my="4">Enrollments</Heading>
      <Box border="1px solid" borderColor="border.muted" borderRadius="md" p="4" mb="4">
        <Heading size="sm" mb={3}>
          Canvas Links
        </Heading>
        <Text fontSize="sm" color="fg.muted" mb={3}>
          Enrollments in this course are linked to the following Canvas sections:
        </Text>
        <List.Root as="ul" pl="4" mb={3}>
          {sections?.map((section: ClassSection) => (
            <List.Item key={section.id} as="li" fontSize="sm">
              <Link href={`https://canvas.instructure.com/courses/${section.canvas_course_id}`}>{section.name}</Link>
            </List.Item>
          ))}
        </List.Root>
        <Toaster />
        <Button
          loading={isSyncing}
          colorPalette="green"
          size="sm"
          variant="surface"
          onClick={async () => {
            setIsSyncing(true);
            const supabase = createClient();
            try {
              await enrollmentSyncCanvas({ course_id: Number(course_id) }, supabase);
              toaster.create({
                title: "Synced Canvas Enrollments",
                description: "Canvas enrollments have been synced",
                type: "success"
              });
            } catch (error) {
              toaster.create({
                title: "Error syncing Canvas Enrollments",
                description: error instanceof Error ? error.message : "An unknown error occurred",
                type: "error"
              });
            }
            setIsSyncing(false);
          }}
        >
          Sync Canvas Enrollments
        </Button>
      </Box>
      <EnrollmentsTable />
    </Container>
  );
}
