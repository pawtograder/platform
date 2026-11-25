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
import { ReportBlock } from "@/components/bugReport/ReportBlock";
import {
  buildSubmissionHref,
  computeDeletionTotals,
  formatCommentLocation,
  type RubricCheckDeletionImpact,
  type RubricCheckDeletionPreview
} from "@/lib/rubric/deletionReport";
import { Badge, Box, Button, Collapsible, HStack, Icon, Input, Link, Table, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuExternalLink, LuRefreshCw, LuTrash2 } from "react-icons/lu";

export type ConfirmRubricCheckDeleteDialogProps = {
  open: boolean;
  preview: RubricCheckDeletionPreview | null;
  courseId: number | string;
  assignmentId: number | string;
  isSubmitting: boolean;
  isRefreshing: boolean;
  staleNotice?: string | null;
  onRefresh: () => void;
  onCancel: () => void;
  onConfirm: () => void;
};

function matchesSearch(check: RubricCheckDeletionImpact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (
    check.check_name.toLowerCase().includes(q) ||
    check.criterion_name.toLowerCase().includes(q) ||
    check.part_name.toLowerCase().includes(q)
  ) {
    return true;
  }
  if (
    check.applications.some(
      (app) =>
        app.student_or_group_name.toLowerCase().includes(q) ||
        app.grader_name.toLowerCase().includes(q) ||
        (app.grader_email ?? "").toLowerCase().includes(q) ||
        (app.file_name ?? "").toLowerCase().includes(q)
    )
  ) {
    return true;
  }
  if (
    check.bare_regrade_requests.some(
      (req) =>
        req.student_or_group_name.toLowerCase().includes(q) ||
        req.assignee_name.toLowerCase().includes(q) ||
        (req.assignee_email ?? "").toLowerCase().includes(q)
    )
  ) {
    return true;
  }
  return false;
}

export function ConfirmRubricCheckDeleteDialog({
  open,
  preview,
  courseId,
  assignmentId,
  isSubmitting,
  isRefreshing,
  staleNotice,
  onRefresh,
  onCancel,
  onConfirm
}: ConfirmRubricCheckDeleteDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedCheckIds, setExpandedCheckIds] = useState<Set<number>>(new Set());

  const checks = useMemo(() => preview?.checks ?? [], [preview]);
  const totals = useMemo(() => computeDeletionTotals(checks), [checks]);

  // Reset search and set sensible default expansion when the preview changes.
  useEffect(() => {
    if (!open || !preview) return;
    setSearchQuery("");
    const totalRows = preview.checks.reduce(
      (sum, c) => sum + c.applications.length + c.bare_regrade_requests.length,
      0
    );
    if (totalRows <= 15 || preview.checks.length === 1) {
      setExpandedCheckIds(new Set(preview.checks.map((c) => c.check_id)));
    } else {
      setExpandedCheckIds(new Set());
    }
  }, [open, preview]);

  const filteredChecks = useMemo(() => {
    if (!searchQuery.trim()) return checks;
    return checks.filter((check) => matchesSearch(check, searchQuery));
  }, [checks, searchQuery]);

  const toggleCheck = (checkId: number) => {
    setExpandedCheckIds((prev) => {
      const next = new Set(prev);
      if (next.has(checkId)) next.delete(checkId);
      else next.add(checkId);
      return next;
    });
  };

  const allExpanded = filteredChecks.length > 0 && filteredChecks.every((c) => expandedCheckIds.has(c.check_id));

  const toggleAll = () => {
    if (allExpanded) {
      setExpandedCheckIds(new Set());
    } else {
      setExpandedCheckIds(new Set(filteredChecks.map((c) => c.check_id)));
    }
  };

  const formattedPreviewTime = useMemo(() => {
    if (!preview?.previewed_at) return null;
    const d = new Date(preview.previewed_at);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString();
  }, [preview?.previewed_at]);

  return (
    <DialogRoot
      open={open}
      onOpenChange={(details) => {
        if (!details.open && !isSubmitting) {
          onCancel();
        }
      }}
      size="xl"
      scrollBehavior="inside"
      closeOnInteractOutside={!isSubmitting}
      closeOnEscape={!isSubmitting}
    >
      <DialogContent maxW="4xl">
        <DialogHeader>
          <VStack align="start" gap={1}>
            <DialogTitle>
              {totals.checkCount === 1
                ? "Delete Applied Rubric Check?"
                : `Delete ${totals.checkCount} Applied Rubric Checks?`}
            </DialogTitle>
            <Text fontSize="sm" color="fg.muted">
              {totals.commentCount > 0 ? (
                <>
                  {totals.checkCount} rubric check{totals.checkCount === 1 ? "" : "s"} applied in{" "}
                  <strong>{totals.commentCount}</strong> comment{totals.commentCount === 1 ? "" : "s"} across{" "}
                  <strong>{totals.distinctSubmissionCount}</strong> submission
                  {totals.distinctSubmissionCount === 1 ? "" : "s"}
                  {totals.distinctGraderCount > 0
                    ? ` (by ${totals.distinctGraderCount} grader${totals.distinctGraderCount === 1 ? "" : "s"})`
                    : ""}
                  .
                </>
              ) : (
                <>
                  {totals.checkCount} rubric check{totals.checkCount === 1 ? "" : "s"} referenced by{" "}
                  <strong>{totals.bareRegradeCount}</strong> active regrade request
                  {totals.bareRegradeCount === 1 ? "" : "s"}.
                </>
              )}
            </Text>
          </VStack>
          {!isSubmitting && <DialogCloseTrigger />}
        </DialogHeader>

        <DialogBody>
          <VStack align="stretch" gap={4}>
            {staleNotice && (
              <Alert status="warning" title="Rubric check usage changed while reviewing">
                <Text fontSize="sm">{staleNotice}</Text>
              </Alert>
            )}

            <Alert status="warning" title="Confirming will remove existing grading comments and recompute scores">
              <VStack align="start" gap={1.5} fontSize="sm">
                <Text>
                  Deleting these rubric check{totals.checkCount === 1 ? "" : "s"} will soft-delete all active grading
                  comments listed below, detach them from the deleted check{totals.checkCount === 1 ? "" : "s"}, and
                  recompute affected submission scores.
                </Text>
                {totals.releasedSubmissionCount > 0 && (
                  <Text fontWeight="semibold" color="fg.error">
                    Warning: {totals.releasedSubmissionCount} affected submission
                    {totals.releasedSubmissionCount === 1 ? " has" : "s have"} already-released grades. Student scores
                    will change immediately when you confirm.
                  </Text>
                )}
                {(totals.activeRegradeCount > 0 || totals.bareRegradeCount > 0) && (
                  <Text>
                    {totals.activeRegradeCount + totals.bareRegradeCount} active regrade request
                    {totals.activeRegradeCount + totals.bareRegradeCount === 1 ? "" : "s"} linked to these check
                    {totals.checkCount === 1 ? "" : "s"} will be automatically resolved.
                  </Text>
                )}
                <Text color="fg.muted">
                  Submission links open in a new tab so you will not lose your unsaved rubric edits. After confirming,
                  you will receive a follow-up report grouped by grader.
                </Text>
              </VStack>
            </Alert>

            <HStack justify="space-between" gap={2} flexWrap="wrap">
              <Input
                size="sm"
                maxW="sm"
                placeholder="Filter by grader, student/group, file, or check..."
                aria-label="Filter affected submissions"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {filteredChecks.length > 1 && (
                <Button size="xs" variant="ghost" onClick={toggleAll}>
                  {allExpanded ? "Collapse all" : "Expand all"}
                </Button>
              )}
            </HStack>

            {filteredChecks.length === 0 ? (
              <Text fontSize="sm" color="fg.muted" py={4} textAlign="center">
                No affected checks match &ldquo;{searchQuery}&rdquo;.
              </Text>
            ) : (
              <VStack align="stretch" gap={3}>
                {filteredChecks.map((check) => {
                  const isOpen = searchQuery.trim().length > 0 || expandedCheckIds.has(check.check_id);
                  const q = searchQuery.trim().toLowerCase();
                  const visibleApps =
                    q &&
                    !check.check_name.toLowerCase().includes(q) &&
                    !check.criterion_name.toLowerCase().includes(q) &&
                    !check.part_name.toLowerCase().includes(q)
                      ? check.applications.filter(
                          (app) =>
                            app.student_or_group_name.toLowerCase().includes(q) ||
                            app.grader_name.toLowerCase().includes(q) ||
                            (app.grader_email ?? "").toLowerCase().includes(q) ||
                            (app.file_name ?? "").toLowerCase().includes(q)
                        )
                      : check.applications;

                  const visibleBareRegrades =
                    q &&
                    !check.check_name.toLowerCase().includes(q) &&
                    !check.criterion_name.toLowerCase().includes(q) &&
                    !check.part_name.toLowerCase().includes(q)
                      ? check.bare_regrade_requests.filter(
                          (req) =>
                            req.student_or_group_name.toLowerCase().includes(q) ||
                            req.assignee_name.toLowerCase().includes(q) ||
                            (req.assignee_email ?? "").toLowerCase().includes(q)
                        )
                      : check.bare_regrade_requests;

                  return (
                    <Box
                      key={check.check_id}
                      border="1px solid"
                      borderColor="border.subtle"
                      borderRadius="md"
                      overflow="hidden"
                    >
                      <Collapsible.Root open={isOpen} onOpenChange={() => toggleCheck(check.check_id)}>
                        <Collapsible.Trigger
                          w="100%"
                          px={3}
                          py={2.5}
                          bg="bg.subtle"
                          display="flex"
                          alignItems="center"
                          justifyContent="space-between"
                          gap={2}
                          textAlign="left"
                          cursor="pointer"
                          _hover={{ bg: "bg.emphasized" }}
                        >
                          <HStack gap={2} minW={0} flex={1}>
                            <Icon as={isOpen ? LuChevronDown : LuChevronRight} flexShrink={0} />
                            <VStack align="start" gap={0} minW={0}>
                              <Text fontSize="xs" color="fg.muted" truncate>
                                {check.part_name} &rsaquo; {check.criterion_name}
                              </Text>
                              <Text fontSize="sm" fontWeight="semibold" truncate>
                                {check.check_name}
                              </Text>
                            </VStack>
                          </HStack>
                          <HStack gap={1.5} flexShrink={0} flexWrap="wrap" justify="flex-end">
                            {check.check_points != null && (
                              <Badge size="sm" variant="outline">
                                {check.check_points} pts
                              </Badge>
                            )}
                            <Badge size="sm" colorPalette="blue" variant="subtle">
                              {check.submission_count} submission{check.submission_count === 1 ? "" : "s"}
                            </Badge>
                            {check.comment_count > 0 && (
                              <Badge size="sm" colorPalette="gray" variant="subtle">
                                {check.comment_count} comment{check.comment_count === 1 ? "" : "s"}
                              </Badge>
                            )}
                            {check.released_submission_count > 0 && (
                              <Badge size="sm" colorPalette="red" variant="subtle">
                                {check.released_submission_count} released
                              </Badge>
                            )}
                            {check.active_regrade_request_count > 0 && (
                              <Badge size="sm" colorPalette="orange" variant="subtle">
                                {check.active_regrade_request_count} open regrade
                                {check.active_regrade_request_count === 1 ? "" : "s"}
                              </Badge>
                            )}
                          </HStack>
                        </Collapsible.Trigger>
                        <Collapsible.Content>
                          <Box px={3} py={2}>
                            {visibleApps.length > 0 && (
                              <Table.Root size="sm" variant="line">
                                <Table.Header>
                                  <Table.Row>
                                    <Table.ColumnHeader>Submission</Table.ColumnHeader>
                                    <Table.ColumnHeader>Grader</Table.ColumnHeader>
                                    <Table.ColumnHeader>Location &amp; Comment</Table.ColumnHeader>
                                    <Table.ColumnHeader textAlign="end">Points</Table.ColumnHeader>
                                  </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                  {visibleApps.map((app) => (
                                    <Table.Row key={`${app.comment_type}-${app.comment_id}`}>
                                      <Table.Cell>
                                        <VStack align="start" gap={0.5}>
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
                                          <HStack gap={1}>
                                            {app.review_released && (
                                              <Badge size="xs" colorPalette="red" variant="subtle">
                                                Released
                                              </Badge>
                                            )}
                                            {!app.is_active && (
                                              <Badge size="xs" colorPalette="gray" variant="outline">
                                                Older submission
                                              </Badge>
                                            )}
                                          </HStack>
                                        </VStack>
                                      </Table.Cell>
                                      <Table.Cell>
                                        <VStack align="start" gap={0}>
                                          <Text fontSize="sm">
                                            <ReportBlock>{app.grader_name}</ReportBlock>
                                          </Text>
                                          {app.grader_email && (
                                            <Text fontSize="xs" color="fg.muted">
                                              <ReportBlock>{app.grader_email}</ReportBlock>
                                            </Text>
                                          )}
                                        </VStack>
                                      </Table.Cell>
                                      <Table.Cell maxW="sm">
                                        <VStack align="start" gap={0.5}>
                                          <Text fontSize="xs" fontFamily="mono" color="fg.muted">
                                            {formatCommentLocation(app)}
                                          </Text>
                                          {app.comment_text && (
                                            <Text fontSize="xs" lineClamp={2}>
                                              <ReportBlock>{app.comment_text}</ReportBlock>
                                            </Text>
                                          )}
                                        </VStack>
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
                            )}

                            {visibleBareRegrades.length > 0 && (
                              <Box mt={visibleApps.length > 0 ? 3 : 0}>
                                <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
                                  Active regrade requests referencing this un-applied check:
                                </Text>
                                <VStack align="stretch" gap={1}>
                                  {visibleBareRegrades.map((req) => (
                                    <HStack
                                      key={req.regrade_request_id}
                                      justify="space-between"
                                      fontSize="xs"
                                      px={2}
                                      py={1}
                                      bg="bg.subtle"
                                      borderRadius="sm"
                                    >
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
                                      <HStack gap={2}>
                                        <Badge size="xs" colorPalette="orange">
                                          {req.status}
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
                          </Box>
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </Box>
                  );
                })}
              </VStack>
            )}
          </VStack>
        </DialogBody>

        <DialogFooter justifyContent="space-between" flexWrap="wrap" gap={2}>
          <HStack gap={2}>
            <Button
              size="sm"
              variant="outline"
              onClick={onRefresh}
              loading={isRefreshing}
              loadingText="Refreshing..."
              disabled={isSubmitting}
            >
              <Icon as={LuRefreshCw} />
              Refresh Usage
            </Button>
            {formattedPreviewTime && (
              <Text fontSize="xs" color="fg.muted">
                Checked at {formattedPreviewTime}
              </Text>
            )}
          </HStack>
          <HStack gap={2}>
            <Button size="sm" variant="outline" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              size="sm"
              colorPalette="red"
              onClick={onConfirm}
              loading={isSubmitting}
              loadingText="Deleting & Saving..."
              disabled={isRefreshing}
            >
              <Icon as={LuTrash2} />
              Delete Checks &amp; Comments and Save
            </Button>
          </HStack>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
