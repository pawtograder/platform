import { Box } from "@pawtograder/webapp";
import { AnalyticsChart } from "@pawtograder/webapp";

const data = [
  { date: "2026-01-12", commits: 8, prs_opened: 1, pr_review_comments: 0, issues_opened: 2, issues_closed: 0, issue_comments: 3 },
  { date: "2026-01-13", commits: 14, prs_opened: 2, pr_review_comments: 4, issues_opened: 1, issues_closed: 1, issue_comments: 5 },
  { date: "2026-01-14", commits: 6, prs_opened: 0, pr_review_comments: 7, issues_opened: 0, issues_closed: 2, issue_comments: 2 },
  { date: "2026-01-15", commits: 21, prs_opened: 3, pr_review_comments: 9, issues_opened: 3, issues_closed: 1, issue_comments: 8 },
  { date: "2026-01-16", commits: 11, prs_opened: 1, pr_review_comments: 2, issues_opened: 1, issues_closed: 3, issue_comments: 4 },
  { date: "2026-01-17", commits: 3, prs_opened: 0, pr_review_comments: 1, issues_opened: 0, issues_closed: 0, issue_comments: 1 },
  { date: "2026-01-18", commits: 17, prs_opened: 2, pr_review_comments: 5, issues_opened: 2, issues_closed: 2, issue_comments: 6 }
];

export const RepoActivity = () => (
  <Box maxW="820px">
    <AnalyticsChart data={data} />
  </Box>
);
