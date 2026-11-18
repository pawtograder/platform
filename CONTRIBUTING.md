# Contributing to Pawtograder

## Working with agents

Most changes to Pawtograder are written with an agent, and that's fine. This section covers what the person opening the PR still owns. It applies to every contributor, and to reviewers as much as authors. The checks an agent runs before it opens or updates a PR are in [`AGENTS.md`](./AGENTS.md#before-you-open-or-update-a-pull-request).

### 1. Every claim in your PR is yours

- "Tests pass" means you ran them on this branch, and the PR shows the command and the result.
- "No new type errors" means you ran `npx tsc --noEmit` on this branch.
- If the PR cites users, TAs or interviews, link the notes.
- If an agent reviewed your change, say an agent did. Don't call it "a review."

A claim is **checked** when you can show the command you or an agent ran, or the page you clicked through, and what it returned.

### 2. Look outside your own PR

- Before you pick a migration version, check the newest one on `staging` and the migrations in every open PR. `AGENTS.md` has a command that lists collisions.
- If your PR touches a migration, a table, an RLS policy or a shared file that another open PR also touches, comment on that PR and link yours.
- Merge `staging` into your branch and keep CI green. A red build isn't something your reviewer should have to work around.

### 3. Answer in words

- A review thread is **answered** when you reply on it: either the commit that fixes it, or why you won't change it. A silent push isn't an answer, and neither is resolving the thread without a reply.
- If you requested changes, come back after the author replies. Approve, or say what's still open.
- Authors and reviewers both answer within 48 hours. For a reviewer, the review request is the question. "I need a day on this one" counts as an answer.
- **Agents answer agents; people answer people.** Your agent can reply to bot reviewers (CodeRabbit, Codex) on its own: fix the finding, or say why not. A reply to a human reviewer comes from you. Draft it with an agent if you like, but edit it until you'd stand behind every word.
- If you promise something by a date and it slips, say so on the thread.
- Re-request a review only after you've pushed a fix or replied on every open thread.

### 4. Size it for a person

- A reviewer should be able to read your PR in one sitting, about 20 minutes. If it's bigger than that, split it into a stack of smaller PRs.
- If your PR is stacked, say which PR it sits on and which commits are new. Or base it on that PR's branch, so the diff shows only yours.
- Include documentation that explains the overall shape of the change and the architectural decisions it makes, so the reviewer doesn't have to work them out from the diff.
- Draft means not ready. Mark the PR ready when you want a review, and don't leave a draft sitting for weeks.

### 5. Talk before you change someone else's work

- If your agent's output changes a teammate's design or reopens a decision that was already made, talk to that person first.
- Check your agent's output yourself before anyone else reads it. Don't ask teammates to run it through their agents.
- Design proposals go in a PR against the design doc, where they can be reviewed line by line, not as a PDF in chat.

### 6. Say what the agent did

- Start every review with an Agent line: what the agent did, and what you checked yourself. For example: "Agent: explained the recalculation path. Findings 1 and 3 came from `/code-review`; I reproduced 1 and couldn't reproduce 3, so I dropped it."

### 7. If writing doesn't settle it, talk

- If a reviewer's concern is still open after one round of written replies, take it to a short conversation, in person or on a call. Do it within two working days, and keep it to about 15 minutes.
- In that conversation, the author shows the reviewer that the change follows these conventions: what they checked and how, which other PRs it touches, and why it's the size it is.
- Afterwards, the author posts a two- or three-line summary on the thread: what was agreed, and what changes.
- Either way the time is well spent. If the author can show it, the reviewer learns how they did it. If they can't, the author learns what was missing.
