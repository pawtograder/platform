"use client";

import { createClient } from "@/utils/supabase/client";
import { Box, Button, Heading, HStack, Text, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function ExamOverviewPage() {
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("exams")
      .select("status, num_pages")
      .eq("assignment_id", assignmentId)
      .maybeSingle()
      .then(({ data }) => {
        setStatus(
          data ? `Template configured (${data.num_pages} page(s), status: ${data.status})` : "No exam template yet"
        );
        setLoading(false);
      });
  }, [assignmentId]);

  const base = `/course/${courseId}/manage/assignments/${assignmentId}/exam`;
  return (
    <VStack align="stretch" gap={4} pt={2}>
      <Heading size="md">Exam Grading</Heading>
      <Text color="fg.muted">
        Upload an exam template, label question regions, then upload scanned student exams to OCR, match to students,
        and create submissions for grading.
      </Text>
      <Box borderWidth="1px" borderRadius="md" p={3}>
        <Text fontSize="sm">{loading ? "Loading…" : status}</Text>
      </Box>
      <HStack>
        <Button asChild colorPalette="green">
          <NextLink href={`${base}/template`}>1. Template &amp; Regions</NextLink>
        </Button>
        <Button asChild variant="outline">
          <NextLink href={`${base}/scans`}>2. Scan &amp; Match</NextLink>
        </Button>
      </HStack>
    </VStack>
  );
}
