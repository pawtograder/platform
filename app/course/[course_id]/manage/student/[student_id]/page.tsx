"use client";
import { AdjustDueDateDialog } from "@/app/course/[course_id]/manage/assignments/[assignment_id]/due-date-exceptions/page";
import { useAllStudentProfiles, useCourseController } from "@/hooks/useCourseController";
import { useUserProfile } from "@/hooks/useUserProfiles";
import { useTableControllerTableValues, useTableControllerValueById } from "@/lib/TableController";
import type { Assignment } from "@/utils/supabase/DatabaseTypes";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { Badge, Box, Card, HStack, Heading, Separator, Skeleton, Table, Text, VStack } from "@chakra-ui/react";
import { Select as ChakraReactSelect, OptionBase } from "chakra-react-select";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type HelpRequest = {
  id: number;
  created_at: string;
  help_queue: number;
  request: string;
  assignee: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  is_private: boolean;
  status: string;
};

type HelpMessage = {
  id: number;
  created_at: string;
  author: string;
  message: string;
  instructors_only: boolean;
  help_request_id: number;
};

type DiscussionThreadLite = {
  id: number;
  created_at: string;
  subject: string;
  body: string;
  instructors_only: boolean;
  parent: number | null;
  root: number;
  topic_id: number;
};

type AssignmentSummary = {
  assignment_id: number;
  title: string;
  release_date: string;
  effective_due_date: string | null;
  submission_id: number | null;
  submission_timestamp: string | null;
  submission_ordinal: number | null;
  autograder_score: number | null;
  total_score: number | null;
};

type PrivateGrade = {
  gradebook_column_id: number;
  score: number | null;
  score_override: number | null;
  released: boolean;
  incomplete_values: Record<string, unknown> | null;
};

type StudentSummary = {
  help_requests: HelpRequest[];
  help_messages: HelpMessage[];
  discussion_posts: DiscussionThreadLite[];
  discussion_replies: DiscussionThreadLite[];
  assignments: AssignmentSummary[];
  grades_private: PrivateGrade[];
};

function AdjustDueDateCell({ assignmentId, studentId }: { assignmentId: number; studentId: string }) {
  const { assignments } = useCourseController();
  const assignment = useTableControllerValueById(assignments, assignmentId) as Assignment | undefined;
  if (!assignment) return null;
  return <AdjustDueDateDialog student_id={studentId} assignment={assignment} />;
}

export default function StudentPage() {
  const { course_id, student_id } = useParams();
  const router = useRouter();
  const { client, gradebookColumns } = useCourseController();
  const [studentSummary, setStudentSummary] = useState<StudentSummary | null>(null);
  const columns = useTableControllerTableValues(gradebookColumns);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const studentProfile = useUserProfile(
    typeof student_id === "string" ? student_id : Array.isArray(student_id) ? student_id[0] : ""
  );
  const allStudents = useAllStudentProfiles();
  useEffect(() => {
    if (!client) return;
    let mounted = true;
    const fetchStudentSummary = async () => {
      setIsLoading(true);
      const { data, error } = await client.rpc("get_student_summary", {
        p_class_id: parseInt(course_id as string, 10),
        p_student_profile_id: student_id as string
      });
      if (error) {
        if (mounted) {
          setStudentSummary(null);
          setIsLoading(false);
        }
        return;
      }
      if (data && mounted) {
        setStudentSummary(data as StudentSummary);
      } else if (mounted) {
        setStudentSummary(null);
      }
      if (mounted) {
        setIsLoading(false);
      }
    };
    fetchStudentSummary();
    return () => {
      mounted = false;
    };
  }, [client, course_id, student_id]);

  const renderEmptyState = (label: string) => <Text color="fg.muted">No {label}.</Text>;

  type GradebookColumnRow = Database["public"]["Tables"]["gradebook_columns"]["Row"];
  const columnsById = useMemo(() => {
    const byId = new Map<number, GradebookColumnRow>();
    columns.forEach((col) => {
      const c = col as unknown as GradebookColumnRow;
      byId.set(c.id as number, c);
    });
    return byId;
  }, [columns]);

  const sortedPrivateGrades = useMemo(() => {
    if (!studentSummary) return [] as PrivateGrade[];
    const list = [...studentSummary.grades_private];
    list.sort((a, b) => {
      const sa = columnsById.get(a.gradebook_column_id)?.sort_order ?? Number.MAX_SAFE_INTEGER;
      const sb = columnsById.get(b.gradebook_column_id)?.sort_order ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return a.gradebook_column_id - b.gradebook_column_id;
    });
    return list;
  }, [studentSummary, columnsById]);

  return (
    <VStack align="stretch" gap={6} px={{ base: 2, md: 4 }} py={4} role="region" aria-label="Student Summary">
      <HStack justify="flex-start" w="full">
        <Heading size="lg">Student Summary</Heading>
        <Box minW={{ base: "240px", md: "320px" }}>
          <ChakraReactSelect
            aria-label="Select student"
            isClearable={false}
            size="sm"
            value={studentProfile ? { label: studentProfile.name || "Student", value: studentProfile.id } : undefined}
            options={allStudents.map((s) => ({ label: s.name || `User ${s.id}`, value: s.id }))}
            onChange={(opt) => {
              const nextId = (opt as OptionBase & { value: string })?.value;
              if (!nextId) return;
              router.push(`/course/${course_id}/manage/student/${nextId}`);
            }}
          />
        </Box>
      </HStack>

      <Card.Root>
        <Card.Header>
          <Heading size="md">Assignments</Heading>
        </Card.Header>
        <Separator />
        <Card.Body>
          {isLoading ? (
            <Skeleton height="220px" />
          ) : studentSummary && studentSummary.assignments.length > 0 ? (
            <Box role="region" aria-label="Assignments table" overflowX="auto">
              <Table.Root variant="outline" size="sm" width="100%">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Title</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Submission #</Table.ColumnHeader>
                    <Table.ColumnHeader>Submission Time</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Autograder Score</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Total Score</Table.ColumnHeader>
                    <Table.ColumnHeader>Due Date</Table.ColumnHeader>
                    <Table.ColumnHeader></Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {studentSummary.assignments.map((a) => (
                    <Table.Row key={a.assignment_id}>
                      <Table.Cell
                        maxW={{ base: 56, md: 96 }}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {a.submission_id ? (
                          <Link
                            href={`/course/${course_id}/assignments/${a.assignment_id}/submissions/${a.submission_id}`}
                          >
                            {a.title}
                          </Link>
                        ) : (
                          a.title
                        )}
                      </Table.Cell>
                      <Table.Cell textAlign="right">
                        {a.submission_id && a.submission_ordinal != null ? (
                          <Link
                            href={`/course/${course_id}/assignments/${a.assignment_id}/submissions/${a.submission_id}`}
                          >
                            #{a.submission_ordinal}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {a.submission_id ? (
                          <Link
                            href={`/course/${course_id}/assignments/${a.assignment_id}/submissions/${a.submission_id}`}
                          >
                            {a.submission_timestamp ? new Date(a.submission_timestamp).toLocaleString() : "—"}
                          </Link>
                        ) : a.submission_timestamp ? (
                          new Date(a.submission_timestamp).toLocaleString()
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell textAlign="right">
                        {a.submission_id ? (
                          <Link
                            href={`/course/${course_id}/assignments/${a.assignment_id}/submissions/${a.submission_id}`}
                          >
                            {a.autograder_score ?? "—"}
                          </Link>
                        ) : (
                          (a.autograder_score ?? "—")
                        )}
                      </Table.Cell>
                      <Table.Cell textAlign="right">
                        {a.submission_id ? (
                          <Link
                            href={`/course/${course_id}/assignments/${a.assignment_id}/submissions/${a.submission_id}`}
                          >
                            {a.total_score ?? "—"}
                          </Link>
                        ) : (
                          (a.total_score ?? "—")
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {a.effective_due_date ? (
                          a.submission_id ? (
                            <Link
                              href={`/course/${course_id}/assignments/${a.assignment_id}/submissions/${a.submission_id}`}
                            >
                              {new Date(a.effective_due_date).toLocaleString()}
                            </Link>
                          ) : (
                            new Date(a.effective_due_date).toLocaleString()
                          )
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <AdjustDueDateCell assignmentId={a.assignment_id} studentId={student_id as string} />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            renderEmptyState("assignments")
          )}
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <HStack justify="space-between" w="full">
            <Heading size="md">Help Requests</Heading>
            {isLoading ? (
              <Skeleton height="20px" width="120px" />
            ) : (
              <Badge>{studentSummary?.help_requests.length ?? 0}</Badge>
            )}
          </HStack>
        </Card.Header>
        <Separator />
        <Card.Body>
          {isLoading ? (
            <Skeleton height="180px" />
          ) : studentSummary && studentSummary.help_requests.length > 0 ? (
            <Box role="region" aria-label="Help requests table" overflowX="auto">
              <Table.Root variant="outline" size="sm" width="100%">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>ID</Table.ColumnHeader>
                    <Table.ColumnHeader>Created</Table.ColumnHeader>
                    <Table.ColumnHeader>Request</Table.ColumnHeader>
                    <Table.ColumnHeader>Assignee</Table.ColumnHeader>
                    <Table.ColumnHeader>Status</Table.ColumnHeader>
                    <Table.ColumnHeader>Resolved</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {studentSummary.help_requests.map((req) => (
                    <Table.Row key={req.id} aria-label={`Help request ${req.id}`}>
                      <Table.Cell>
                        <Link href={`/course/${course_id}/manage/office-hours/request/${req.id}`}>#{req.id}</Link>
                      </Table.Cell>
                      <Table.Cell>{new Date(req.created_at).toLocaleString()}</Table.Cell>
                      <Table.Cell
                        maxW={{ base: 56, md: 96 }}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        <Link href={`/course/${course_id}/manage/office-hours/request/${req.id}`}>{req.request}</Link>
                      </Table.Cell>
                      <Table.Cell>{req.assignee ?? "—"}</Table.Cell>
                      <Table.Cell>
                        <Badge>{req.status}</Badge>
                      </Table.Cell>
                      <Table.Cell>{req.resolved_at ? new Date(req.resolved_at).toLocaleString() : "—"}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            renderEmptyState("help requests")
          )}
        </Card.Body>
      </Card.Root>

      {/* <Card.Root>
        <Card.Header>
          <HStack justify="space-between" w="full">
            <Heading size="md">Help Messages</Heading>
            {isLoading ? <Skeleton height="20px" width="120px" /> : <Badge>{studentSummary?.help_messages.length ?? 0}</Badge>}
          </HStack>
        </Card.Header>
        <Separator />
        <Card.Body>
          {isLoading ? (
            <Skeleton height="180px" />
          ) : (studentSummary && studentSummary.help_messages.length > 0 ? (
            <Box role="region" aria-label="Help messages table" overflowX="auto">
              <Table.Root variant="outline" size="sm" width="100%">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>ID</Table.ColumnHeader>
                    <Table.ColumnHeader>Created</Table.ColumnHeader>
                    <Table.ColumnHeader>Author</Table.ColumnHeader>
                    <Table.ColumnHeader>Message</Table.ColumnHeader>
                    <Table.ColumnHeader>Instructors Only</Table.ColumnHeader>
                    <Table.ColumnHeader>Help Request</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {studentSummary.help_messages.map((msg) => (
                    <Table.Row key={msg.id}>
                      <Table.Cell>
                        <Link href={`/course/${course_id}/manage/office-hours/request/${msg.help_request_id}`}>#{msg.id}</Link>
                      </Table.Cell>
                      <Table.Cell>{new Date(msg.created_at).toLocaleString()}</Table.Cell>
                      <Table.Cell>{msg.author}</Table.Cell>
                      <Table.Cell maxW={{ base: 56, md: 96 }} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">{msg.message}</Table.Cell>
                      <Table.Cell>{msg.instructors_only ? "Yes" : "No"}</Table.Cell>
                      <Table.Cell>
                        <Link href={`/course/${course_id}/manage/office-hours/request/${msg.help_request_id}`}>#{msg.help_request_id}</Link>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            renderEmptyState("help messages")
          ))}
        </Card.Body>
      </Card.Root> */}

      <Card.Root>
        <Card.Header>
          <Heading size="md">Discussion Posts</Heading>
        </Card.Header>
        <Separator />
        <Card.Body>
          {isLoading ? (
            <Skeleton height="160px" />
          ) : studentSummary && studentSummary.discussion_posts.length > 0 ? (
            <Box role="region" aria-label="Discussion posts table" overflowX="auto">
              <Table.Root variant="outline" size="sm" width="100%">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>ID</Table.ColumnHeader>
                    <Table.ColumnHeader>Created</Table.ColumnHeader>
                    <Table.ColumnHeader>Subject</Table.ColumnHeader>
                    <Table.ColumnHeader>Instructors Only</Table.ColumnHeader>
                    <Table.ColumnHeader>Topic</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {studentSummary.discussion_posts.map((post) => (
                    <Table.Row key={post.id}>
                      <Table.Cell>
                        <Link href={`/course/${course_id}/discussion/${post.id}`}>#{post.id}</Link>
                      </Table.Cell>
                      <Table.Cell>{new Date(post.created_at).toLocaleString()}</Table.Cell>
                      <Table.Cell
                        maxW={{ base: 56, md: 96 }}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        <Link href={`/course/${course_id}/discussion/${post.id}`}>{post.subject}</Link>
                      </Table.Cell>
                      <Table.Cell>{post.instructors_only ? "Yes" : "No"}</Table.Cell>
                      <Table.Cell>{post.topic_id}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            renderEmptyState("discussion posts")
          )}
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Heading size="md">Discussion Replies</Heading>
        </Card.Header>
        <Separator />
        <Card.Body>
          {isLoading ? (
            <Skeleton height="160px" />
          ) : studentSummary && studentSummary.discussion_replies.length > 0 ? (
            <Box role="region" aria-label="Discussion replies table" overflowX="auto">
              <Table.Root variant="outline" size="sm" width="100%">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>ID</Table.ColumnHeader>
                    <Table.ColumnHeader>Created</Table.ColumnHeader>
                    <Table.ColumnHeader>Body</Table.ColumnHeader>
                    <Table.ColumnHeader>Instructors Only</Table.ColumnHeader>
                    <Table.ColumnHeader>Root</Table.ColumnHeader>
                    <Table.ColumnHeader>Parent</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {studentSummary.discussion_replies.map((reply) => (
                    <Table.Row key={reply.id}>
                      <Table.Cell>
                        <Link href={`/course/${course_id}/discussion/${reply.root}`}>#{reply.id}</Link>
                      </Table.Cell>
                      <Table.Cell>{new Date(reply.created_at).toLocaleString()}</Table.Cell>
                      <Table.Cell
                        maxW={{ base: 56, md: 96 }}
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        <Link href={`/course/${course_id}/discussion/${reply.root}`}>{reply.body}</Link>
                      </Table.Cell>
                      <Table.Cell>{reply.instructors_only ? "Yes" : "No"}</Table.Cell>
                      <Table.Cell>{reply.root}</Table.Cell>
                      <Table.Cell>{reply.parent}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            renderEmptyState("discussion replies")
          )}
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Heading size="md">Grades</Heading>
        </Card.Header>
        <Separator />
        <Card.Body>
          {isLoading ? (
            <Skeleton height="180px" />
          ) : studentSummary && studentSummary.grades_private.length > 0 ? (
            <Box role="region" aria-label="Private grades table" overflowX="auto">
              <Table.Root variant="outline" size="sm" width="100%">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Column</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Score</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Override</Table.ColumnHeader>
                    <Table.ColumnHeader>Released</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {sortedPrivateGrades.map((g) => (
                    <Table.Row key={`${g.gradebook_column_id}`}>
                      <Table.Cell>{columnsById.get(g.gradebook_column_id)?.name ?? g.gradebook_column_id}</Table.Cell>
                      <Table.Cell textAlign="right">{g.score ?? "—"}</Table.Cell>
                      <Table.Cell textAlign="right">{g.score_override ?? "—"}</Table.Cell>
                      <Table.Cell>{g.released ? "Yes" : "No"}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            renderEmptyState("private grades")
          )}
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
