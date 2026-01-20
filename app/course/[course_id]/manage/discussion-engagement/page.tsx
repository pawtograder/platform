import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getUserRolesForCourse } from "@/lib/ssrUtils";
import { Box, Container, Heading, Stack, Text, Table, Badge, HStack, Flex, VStack } from "@chakra-ui/react";
import { KarmaBadge } from "@/components/discussion/KarmaBadge";
import { ExportButton } from "./ExportButton";
import { TrophyIcon } from "./TrophyIcon";

type StudentEngagement = {
  profile_id: string;
  name: string;
  discussion_karma: number;
  total_posts: number;
  total_replies: number;
  likes_received: number;
  likes_given: number;
};

async function getStudentEngagement(course_id: number): Promise<StudentEngagement[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_discussion_engagement", {
    p_class_id: course_id
  });

  if (error || !data) {
    return [];
  }

  return data;
}

export default async function DiscussionEngagementPage({ params }: { params: Promise<{ course_id: string }> }) {
  const course_id = Number.parseInt((await params).course_id);
  const headersList = await headers();
  const user_id = headersList.get("X-User-ID");

  if (!user_id) {
    redirect("/");
  }

  const role = await getUserRolesForCourse(course_id, user_id);
  if (!role || (role.role !== "instructor" && role.role !== "grader")) {
    redirect("/");
  }

  // Check if discussion feature is enabled
  const supabase = await createClient();
  const { data: courseData } = await supabase.from("classes").select("features").eq("id", course_id).single();

  if (courseData?.features && Array.isArray(courseData.features)) {
    const features = courseData.features as { name: string; enabled: boolean }[];
    const discussionFeature = features.find((f) => f.name === "discussion");
    if (discussionFeature && !discussionFeature.enabled) {
      redirect(`/course/${course_id}`);
    }
  }

  const engagement = await getStudentEngagement(course_id);

  // Calculate summary statistics
  const totalStudents = engagement.length;
  const totalKarma = engagement.reduce((sum, s) => sum + s.discussion_karma, 0);
  const avgKarma = totalStudents > 0 ? Math.round((totalKarma / totalStudents) * 10) / 10 : 0;
  const totalPosts = engagement.reduce((sum, s) => sum + s.total_posts, 0);
  const totalReplies = engagement.reduce((sum, s) => sum + s.total_replies, 0);
  const totalActivity = totalPosts + totalReplies;
  // Find the student with the highest total activity (posts + replies)
  const mostActive =
    engagement.length > 0
      ? engagement.reduce((max, student) => {
          const maxActivity = max.total_posts + max.total_replies;
          const studentActivity = student.total_posts + student.total_replies;
          return studentActivity > maxActivity ? student : max;
        })
      : null;

  return (
    <Container maxW="container.xl" py={6}>
      <Flex justify="space-between" align="center" mb={6}>
        <Box>
          <Heading size="lg">Discussion Engagement</Heading>
          <Text color="fg.muted" mt={1}>
            Track student participation and karma in discussion boards
          </Text>
        </Box>
        <ExportButton engagement={engagement} course_id={course_id} />
      </Flex>

      {/* Summary Statistics */}
      <Stack direction={{ base: "column", md: "row" }} gap={4} mb={6}>
        <Box flex="1" p={4} borderWidth="1px" borderRadius="md" bg="bg.panel">
          <VStack align="start" gap={2}>
            <Text fontSize="sm" color="fg.muted">
              Total Students
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {totalStudents}
            </Text>
          </VStack>
        </Box>
        <Box flex="1" p={4} borderWidth="1px" borderRadius="md" bg="bg.panel">
          <VStack align="start" gap={2}>
            <Text fontSize="sm" color="fg.muted">
              Average Karma
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {avgKarma}
            </Text>
          </VStack>
        </Box>
        <Box flex="1" p={4} borderWidth="1px" borderRadius="md" bg="bg.panel">
          <VStack align="start" gap={2}>
            <Text fontSize="sm" color="fg.muted">
              Total Activity
            </Text>
            <Text fontSize="2xl" fontWeight="bold">
              {totalActivity}
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {totalPosts} posts, {totalReplies} replies
            </Text>
          </VStack>
        </Box>
        {mostActive && (
          <Box flex="1" p={4} borderWidth="1px" borderRadius="md" bg="bg.panel">
            <VStack align="start" gap={2}>
              <Text fontSize="sm" color="fg.muted">
                Most Active
              </Text>
              <HStack gap={2}>
                <TrophyIcon />
                <Text fontSize="lg" fontWeight="bold" truncate>
                  {mostActive.name}
                </Text>
              </HStack>
              <Text fontSize="xs" color="fg.muted">
                {mostActive.total_posts + mostActive.total_replies} activities
              </Text>
            </VStack>
          </Box>
        )}
      </Stack>

      {/* Engagement Table */}
      <Box borderWidth="1px" borderRadius="md" overflow="hidden">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Rank</Table.ColumnHeader>
              <Table.ColumnHeader>Student</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Karma</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Posts</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Replies</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Likes Received</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Likes Given</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="center">Total Activity</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {engagement.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={8} textAlign="center" py={8}>
                  <Text color="fg.muted">No student engagement data available</Text>
                </Table.Cell>
              </Table.Row>
            ) : (
              engagement.map((student, index) => (
                <Table.Row key={student.profile_id}>
                  <Table.Cell>
                    <Badge variant="subtle" colorPalette={index < 3 ? "yellow" : "gray"}>
                      #{index + 1}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <HStack gap={2}>
                      <Text fontWeight="medium">{student.name}</Text>
                      <KarmaBadge karma={student.discussion_karma} />
                    </HStack>
                  </Table.Cell>
                  <Table.Cell textAlign="center">
                    <Text fontWeight="semibold">{student.discussion_karma}</Text>
                  </Table.Cell>
                  <Table.Cell textAlign="center">{student.total_posts}</Table.Cell>
                  <Table.Cell textAlign="center">{student.total_replies}</Table.Cell>
                  <Table.Cell textAlign="center">{student.likes_received}</Table.Cell>
                  <Table.Cell textAlign="center">{student.likes_given}</Table.Cell>
                  <Table.Cell textAlign="center">
                    <Text fontWeight="medium">{student.total_posts + student.total_replies}</Text>
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      </Box>
    </Container>
  );
}
