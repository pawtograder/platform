"use client";

import { Alert } from "@/components/ui/alert";
import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { toaster } from "@/components/ui/toaster";
import { ReportBlock } from "@/components/bugReport/ReportBlock";
import {
  buildSubmissionHref,
  computeDeletionTotals,
  formatCommentLocation,
  formatDeletedChecksCsv,
  formatFullDeletionReportMarkdown,
  formatGraderFollowUpMessage,
  groupDeletionsByGrader,
  type DeletedRubricChecksReport,
  type GraderFollowUpGroup
} from "@/lib/rubric/deletionReport";
import { Badge, Box, Button, Flex, HStack, Icon, Link, Table, Text, VStack } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { LuCheck, LuCopy, LuDownload, LuExternalLink } from "react-icons/lu";

export type DeletedChecksReportDialogProps = {
  open: boolean;
  report: DeletedRubricChecksReport | null;
  courseId: number | string;
  assignmentId: number | string;
  assignmentTitle?: string;
  onClose: () => void;
};

export function DeletedChecksReportDialog({
  open,
  report,
  courseId,
  assignmentId,
  assignmentTitle,
  onClose
}: DeletedChecksReportDialogProps) {
  const [activeTab, setActiveTab] = useState<"grader" | "check">("grader");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const checks = useMemo(() => report?.checks ?? [], [report]);
  const totals = useMemo(() => computeDeletionTotals(checks), [checks]);
  const graderGroups = useMemo(() => groupDeletionsByGrader(checks), [checks]);
  const allBareRegrades = useMemo(
    () => checks.flatMap((check) => check.bare_regrade_requests.map((req) => ({ check, req }))),
    [checks]
  );

  const origin = typeof window !== "undefined" ? window.location.origin : undefined;

  const copyText = async (key: string, text: string, successTitle: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toaster.success({ title: successTitle, duration: 3000 });
      setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2500);
    } catch {
      toaster.error({
        title: "Could not copy to clipboard",
        description: "Your browser blocked clipboard access. Try downloading the CSV instead."
      });
    }
  };

  const handleCopyFullMarkdown = () => {
    if (!report) return;
    const md = formatFullDeletionReportMarkdown(report, {
      assignmentTitle,
      courseId,
      assignmentId,
      origin
    });
    void copyText("full-markdown", md, "Copied full follow-up report (Markdown)");
  };

  const handleCopyGraderMessage = (group: GraderFollowUpGroup) => {
    if (!report) return;
    const msg = formatGraderFollowUpMessage(group, {
      assignmentTitle,
      rubricName: report.rubric_name,
      courseId,
      assignmentId,
      origin
    });
    void copyText(`grader:${group.graderKey}`, msg, `Copied follow-up message for ${group.grader_name}`);
  };

  const handleDownloadCsv = () => {
    if (!report) return;
    const csv = formatDeletedChecksCsv(report, { courseId, assignmentId, origin });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = report.deleted_at.replace(/[:.]/g, "-").slice(0, 19);
    link.href = url;
    link.download = `deleted-rubric-checks-assignment-${assignmentId}-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toaster.success({ title: "Downloaded CSV follow-up report", duration: 3000 });
  };

  return (
    <DialogRoot
      open={open}
      onOpenChange={(details) => {
        if (!details.open) onClose();
      }}
      size="xl"
      scrollBehavior="inside"
    >
      <DialogContent maxW="4xl">
        <DialogHeader>
          <VStack align="start" gap={1}>
            <DialogTitle>Rubric Saved — Follow-Up Report</DialogTitle>
            <Text fontSize="sm" color="fg.muted">
              Deleted {totals.checkCount} applied rubric check{totals.checkCount === 1 ? "" : "s"}
              {totals.commentCount > 0
                ? `, soft-deleted ${totals.commentCount} comment${totals.commentCount === 1 ? "" : "s"} across ${totals.distinctSubmissionCount} submission${totals.distinctSubmissionCount === 1 ? "" : "s"} (${totals.distinctGraderCount} grader${totals.distinctGraderCount === 1 ? "" : "s"})`
                : ""}
              .
            </Text>
          </VStack>
          <DialogCloseTrigger />
        </DialogHeader>

        <DialogBody>
          <VStack align="stretch" gap={4}>
            <Flex justify="space-between" align="center" flexWrap="wrap" gap={2}>
              <HStack gap={1.5} flexWrap="wrap">
                <Badge size="md" colorPalette="red" variant="subtle">
                  {totals.checkCount} check{totals.checkCount === 1 ? "" : "s"} deleted
                </Badge>
                <Badge size="md" colorPalette="blue" variant="subtle">
                  {totals.distinctSubmissionCount} submission{totals.distinctSubmissionCount === 1 ? "" : "s"}
                </Badge>
                <Badge size="md" colorPalette="gray" variant="subtle">
                  {totals.commentCount} comment{totals.commentCount === 1 ? "" : "s"} removed
                </Badge>
                <Badge size="md" colorPalette="purple" variant="subtle">
                  {totals.distinctGraderCount} grader{totals.distinctGraderCount === 1 ? "" : "s"}
                </Badge>
                {totals.releasedSubmissionCount > 0 && (
                  <Badge size="md" colorPalette="orange" variant="subtle">
                    {totals.releasedSubmissionCount} released
                  </Badge>
                )}
              </HStack>

              <HStack gap={2}>
                <Button size="xs" variant="outline" onClick={handleCopyFullMarkdown} disabled={!report}>
                  <Icon as={copiedKey === "full-markdown" ? LuCheck : LuCopy} />
                  {copiedKey === "full-markdown" ? "Copied Markdown" : "Copy Report (Markdown)"}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={handleDownloadCsv}
                  disabled={!report || (totals.commentCount === 0 && totals.bareRegradeCount === 0)}
                >
                  <Icon as={LuDownload} />
                  Download CSV
                </Button>
              </HStack>
            </Flex>

            {totals.releasedSubmissionCount > 0 && (
              <Alert status="warning" title="Affected submissions had already-released grades">
                <Text fontSize="sm">
                  {totals.releasedSubmissionCount} submission
                  {totals.releasedSubmissionCount === 1 ? "" : "s"} had released grades. Their scores have been
                  recomputed; coordinate with the grader{totals.distinctGraderCount === 1 ? "" : "s"} below if
                  replacement feedback or adjustments are needed.
                </Text>
              </Alert>
            )}

            <HStack gap={1} borderBottom="1px solid" borderColor="border.subtle" pb={1}>
              <Button
                size="xs"
                variant={activeTab === "grader" ? "solid" : "ghost"}
                onClick={() => setActiveTab("grader")}
              >
                By Grader ({graderGroups.length})
              </Button>
              <Button
                size="xs"
                variant={activeTab === "check" ? "solid" : "ghost"}
                onClick={() => setActiveTab("check")}
              >
                By Rubric Check ({checks.length})
              </Button>
            </HStack>

            {activeTab === "grader" && (
              <VStack align="stretch" gap={3}>
                {graderGroups.length === 0 ? (
                  <Text fontSize="sm" color="fg.muted">
                    No grading comments were removed. See auto-closed regrade requests below.
                  </Text>
                ) : (
                  graderGroups.map((group) => {
                    const isCopied = copiedKey === `grader:${group.graderKey}`;
                    return (
                      <Box
                        key={group.graderKey}
                        border="1px solid"
                        borderColor="border.subtle"
                        borderRadius="md"
                        overflow="hidden"
                      >
                        <Flex
                          px={3}
                          py={2}
                          bg="bg.subtle"
                          justify="space-between"
                          align="center"
                          gap={2}
                          flexWrap="wrap"
                        >
                          <VStack align="start" gap={0}>
                            <HStack gap={2} flexWrap="wrap">
                              <Text fontWeight="semibold" fontSize="sm">
                                <ReportBlock>{group.grader_name}</ReportBlock>
                              </Text>
                              {group.grader_email && (
                                <Text fontSize="xs" color="fg.muted">
                                  <ReportBlock>{group.grader_email}</ReportBlock>
                                </Text>
                              )}
                            </HStack>
                            <HStack gap={1.5} mt={0.5}>
                              <Badge size="xs" colorPalette="blue" variant="subtle">
                                {group.distinctSubmissionCount} submission
                                {group.distinctSubmissionCount === 1 ? "" : "s"}
                              </Badge>
                              <Badge size="xs" colorPalette="gray" variant="subtle">
                                {group.commentCount} comment{group.commentCount === 1 ? "" : "s"}
                              </Badge>
                              {group.releasedSubmissionCount > 0 && (
                                <Badge size="xs" colorPalette="red" variant="subtle">
                                  {group.releasedSubmissionCount} released
                                </Badge>
                              )}
                            </HStack>
                          </VStack>
                          <Button size="xs" variant="surface" onClick={() => handleCopyGraderMessage(group)}>
                            <Icon as={isCopied ? LuCheck : LuCopy} />
                            {isCopied ? "Copied" : "Copy follow-up message"}
                          </Button>
                        </Flex>
                        <Box px={3} py={2}>
                          <Table.Root size="sm" variant="line">
                            <Table.Header>
                              <Table.Row>
                                <Table.ColumnHeader>Submission</Table.ColumnHeader>
                                <Table.ColumnHeader>Deleted Check</Table.ColumnHeader>
                                <Table.ColumnHeader>Location</Table.ColumnHeader>
                                <Table.ColumnHeader textAlign="end">Points</Table.ColumnHeader>
                              </Table.Row>
                            </Table.Header>
                            <Table.Body>
                              {group.items.map((item) => (
                                <Table.Row key={`${item.comment_type}-${item.comment_id}`}>
                                  <Table.Cell>
                                    <HStack gap={1.5} flexWrap="wrap">
                                      <Link
                                        href={buildSubmissionHref(courseId, assignmentId, item.submission_id)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        colorPalette="blue"
                                        fontWeight="medium"
                                        fontSize="sm"
                                        display="inline-flex"
                                        alignItems="center"
                                        gap={1}
                                      >
                                        <ReportBlock>{item.student_or_group_name}</ReportBlock>
                                        {item.submission_ordinal != null && (
                                          <Text as="span" color="fg.muted" fontSize="xs">
                                            #{item.submission_ordinal}
                                          </Text>
                                        )}
                                        <Icon as={LuExternalLink} boxSize={3} />
                                      </Link>
                                      {item.review_released && (
                                        <Badge size="xs" colorPalette="red" variant="subtle">
                                          Released
                                        </Badge>
                                      )}
                                    </HStack>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <VStack align="start" gap={0}>
                                      <Text fontSize="xs" color="fg.muted">
                                        {item.part_name} &rsaquo; {item.criterion_name}
                                      </Text>
                                      <Text fontSize="sm">{item.check_name}</Text>
                                    </VStack>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <Text fontSize="xs" fontFamily="mono" color="fg.muted">
                                      <ReportBlock>{formatCommentLocation(item)}</ReportBlock>
                                    </Text>
                                  </Table.Cell>
                                  <Table.Cell textAlign="end" whiteSpace="nowrap">
                                    {item.points != null ? (
                                      <Badge size="sm" variant="subtle">
                                        <ReportBlock>{item.points} pts</ReportBlock>
                                      </Badge>
                                    ) : (
                                      <Text fontSize="xs" color="fg.muted">
                                        —
                                      </Text>
                                    )}
                                  </Table.Cell>
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Root>
                        </Box>
                      </Box>
                    );
                  })
                )}
              </VStack>
            )}

            {activeTab === "check" && (
              <VStack align="stretch" gap={3}>
                {checks.map((check) => (
                  <Box
                    key={check.check_id}
                    border="1px solid"
                    borderColor="border.subtle"
                    borderRadius="md"
                    overflow="hidden"
                  >
                    <Flex px={3} py={2} bg="bg.subtle" justify="space-between" align="center" gap={2} flexWrap="wrap">
                      <VStack align="start" gap={0}>
                        <Text fontSize="xs" color="fg.muted">
                          {check.part_name} &rsaquo; {check.criterion_name}
                        </Text>
                        <Text fontWeight="semibold" fontSize="sm">
                          {check.check_name}
                        </Text>
                      </VStack>
                      <HStack gap={1.5}>
                        {check.check_points != null && (
                          <Badge size="xs" variant="outline">
                            {check.check_points} pts
                          </Badge>
                        )}
                        <Badge size="xs" colorPalette="blue" variant="subtle">
                          {check.submission_count} submission{check.submission_count === 1 ? "" : "s"}
                        </Badge>
                        <Badge size="xs" colorPalette="gray" variant="subtle">
                          {check.comment_count} comment{check.comment_count === 1 ? "" : "s"}
                        </Badge>
                      </HStack>
                    </Flex>
                    {check.applications.length > 0 && (
                      <Box px={3} py={2}>
                        <Table.Root size="sm" variant="line">
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeader>Submission</Table.ColumnHeader>
                              <Table.ColumnHeader>Grader</Table.ColumnHeader>
                              <Table.ColumnHeader>Location</Table.ColumnHeader>
                              <Table.ColumnHeader textAlign="end">Points</Table.ColumnHeader>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {check.applications.map((app) => (
                              <Table.Row key={`${app.comment_type}-${app.comment_id}`}>
                                <Table.Cell>
                                  <HStack gap={1.5}>
                                    <Link
                                      href={buildSubmissionHref(courseId, assignmentId, app.submission_id)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      colorPalette="blue"
                                      fontWeight="medium"
                                      fontSize="sm"
                                      display="inline-flex"
                                      alignItems="center"
                                      gap={1}
                                    >
                                      <ReportBlock>{app.student_or_group_name}</ReportBlock>
                                      {app.submission_ordinal != null && (
                                        <Text as="span" color="fg.muted" fontSize="xs">
                                          #{app.submission_ordinal}
                                        </Text>
                                      )}
                                      <Icon as={LuExternalLink} boxSize={3} />
                                    </Link>
                                    {app.review_released && (
                                      <Badge size="xs" colorPalette="red" variant="subtle">
                                        Released
                                      </Badge>
                                    )}
                                  </HStack>
                                </Table.Cell>
                                <Table.Cell>
                                  <Text fontSize="sm">
                                    <ReportBlock>{app.grader_name}</ReportBlock>
                                  </Text>
                                  {app.grader_email && (
                                    <Text fontSize="xs" color="fg.muted">
                                      <ReportBlock>{app.grader_email}</ReportBlock>
                                    </Text>
                                  )}
                                </Table.Cell>
                                <Table.Cell>
                                  <Text fontSize="xs" fontFamily="mono" color="fg.muted">
                                    <ReportBlock>{formatCommentLocation(app)}</ReportBlock>
                                  </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="end" whiteSpace="nowrap">
                                  {app.points != null ? (
                                    <Badge size="sm" variant="subtle">
                                      <ReportBlock>{app.points} pts</ReportBlock>
                                    </Badge>
                                  ) : (
                                    <Text fontSize="xs" color="fg.muted">
                                      —
                                    </Text>
                                  )}
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Root>
                      </Box>
                    )}
                  </Box>
                ))}
              </VStack>
            )}

            {allBareRegrades.length > 0 && (
              <Box border="1px solid" borderColor="border.subtle" borderRadius="md" p={3}>
                <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2}>
                  Auto-Resolved Regrade Requests (Un-Applied Checks)
                </Text>
                <VStack align="stretch" gap={1.5}>
                  {allBareRegrades.map(({ check, req }) => (
                    <HStack key={req.regrade_request_id} justify="space-between" fontSize="xs" flexWrap="wrap">
                      <HStack gap={2}>
                        <Link
                          href={buildSubmissionHref(courseId, assignmentId, req.submission_id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          colorPalette="blue"
                          display="inline-flex"
                          alignItems="center"
                          gap={1}
                        >
                          <ReportBlock>{req.student_or_group_name}</ReportBlock>
                          {req.submission_ordinal != null && ` #${req.submission_ordinal}`}
                          <Icon as={LuExternalLink} boxSize={3} />
                        </Link>
                        <Text color="fg.muted">
                          &mdash; <strong>{check.check_name}</strong>
                        </Text>
                      </HStack>
                      <HStack gap={2}>
                        <Badge size="xs" colorPalette="orange">
                          was {req.status}
                        </Badge>
                        <Text color="fg.muted">
                          Assignee: <ReportBlock>{req.assignee_name}</ReportBlock>
                        </Text>
                      </HStack>
                    </HStack>
                  ))}
                </VStack>
              </Box>
            )}
          </VStack>
        </DialogBody>

        <DialogFooter justifyContent="space-between" flexWrap="wrap" gap={2}>
          <Text fontSize="xs" color="fg.muted">
            You can reopen this report from the banner at the top of the rubric editor during this session.
          </Text>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
