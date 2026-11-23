// The handout's .github/workflows/grade.yml on Forgejo (#1253). The chart's example is the source; the test
// keeps this copy identical to it apart from the grading server, since edge functions can't read the chart.
/** autograder.workflow_sha for a grade.yml: the SHA-256 of its text, as hex, as updateAutograderWorkflowHash stores on GitHub. */
export async function gradeWorkflowSha(workflow: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workflow));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const forgejoGradeWorkflow = (
  gradingServer: string
) => `# Goes at .github/workflows/grade.yml in the Forgejo handout repo; see README "Grade workflow on Forgejo".
#
# To the intrepid student: You must not edit this file. Tampering with this file could
# reveal the instructor's solution to you. Hence, Pawtograder will automatically compare
# the hash of this file (when the submission is being created) to the hash of the file
# provided in your handout. In addition to failing to register a submission (and not
# providing the workflow with access to the instructor's solution), your instructors will
# be notified of this security violation.

name: Submit Assignment and Run Grader
# Forgejo ignores \`permissions: id-token: write\`; this is what gives the job an OIDC token.
enable-openid-connect: true
permissions:
  id-token: write
  contents: read
on:
  # Required for Pawtograder to create a submission, do not remove
  workflow_dispatch:
  push:
    branches:
      - main
# Forgejo otherwise cancels a student's earlier runs on each push; GitHub doesn't.
concurrency:
  cancel-in-progress: false

jobs:
  grade:
    name: Submit and Grade Assignment
    # The runner image already has JDK 21, Maven, Python 3, Node 22 and git; setup-* steps would hit GitHub every run.
    runs-on: ubuntu-latest
    steps:
      # An action not in forgejoRunner.actions.mirrors needs its full https://... URL.
      - name: Checkout
        id: checkout
        uses: actions/checkout@v4
        with:
          path: submission
      - name: Collect Submission and Run Grader
        uses: pawtograder/assignment-action@v4
        with:
          grading_server: ${JSON.stringify(gradingServer)}
          # Literals: Forgejo's runner leaves github.action_ref/action_repository empty; match \`uses:\`.
          action_ref: "v4"
          action_repository: "pawtograder/assignment-action"
`;
