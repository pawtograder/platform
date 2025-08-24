# Pawtograder for Instructors

This guide explains how to run your course with Pawtograder. It focuses on the core workflows instructors perform and the nuances behind each feature.

- Audience: instructors, head TAs, course staff
- Scope: assignments and grading, gradebook, office hours queue, discussions, notifications, roster/admin basics, GitHub integration
- Time zones: All dates/times are displayed in your course time zone.

## Getting started

- Sign in and switch into your course from the top navigation.
- Link your GitHub account if prompted. If your course uses a GitHub organization, you may need to accept the org invitation. You can resend from the Assignments page if needed.
- Instructor dashboard highlights recent assignments, discussions, and help requests.

## Course navigation

- Course home: Overview and quick links.
- Assignments: Student view, plus instructor tools when you have staff role.
- Manage → Assignments: Create/manage assignments, check activity and regrade requests.
- Gradebook: Student-facing view and What‑If page.
- Manage → Gradebook: Full gradebook management, imports, calculations, releases.
- Office Hours: Student queues; instructor chat, video, moderation.
- Manage → Office Hours: Manage queues, templates, moderation, feedback.
- Discussion: Topics and threads with watches/likes.

---

## Assignments

### Creating and managing assignments

- Path: `Manage → Assignments`
- Create an assignment with title, release date, due date, and group configuration:
  - Individual or group-based; group repos are tracked at the group level.
  - Self‑review can be enabled; a separate due window is computed relative to the submission due date.
- GitHub linking:
  - Link a template repo and optionally auto-create student repos.
  - Use "Create Student Repos" to provision repositories for enrolled students or groups.
- Due‑date exceptions:
  - Per‑student extension support is built in; the system computes an effective due date considering lab sections and explicit exceptions.
- Time zones:
  - All dates render in the course time zone; internal storage uses UTC.

### Student submissions

- Students see assigned work and links to their repos on the Assignments page.
- Active submission: Each assignment tracks the latest active submission. Students can “finalize early” if enabled.
- Group submissions: When grouped, any member submission counts for the group.

### Grading and results

- Review UI: The submission details show files, line comments, autograder results, and rubric scoring.
- Regrade requests:
  - States: opened → resolved/closed. The instructor dashboard surfaces open requests.
- Self‑review:
  - If enabled, students complete a separate review assignment; the link appears under the original assignment with its own due window.

### Instructor dashboard assignment metrics

- Recently due assignments summarize:
  - Submissions vs. repos accepted
  - Graded counts
  - Open/closed regrade requests
  - Students with valid extensions that extend beyond “now”

---

## Gradebook

There are two gradebook areas:

- Gradebook (student/staff): Read‑only grid with student grades and links to related submissions.
- Manage → Gradebook (instructor): Full editor for columns, calculations, releases, and imports.

### Concepts

- Columns: Each column may be a manual grade, a linked assignment score, or a calculated value.
- Dependencies: Columns can depend on other columns and assignments.
- Release status: Grades are hidden until released. Dependencies must be released before a column is considered releasable.
- Overrides and statuses: Missing, Excused, In progress, Not submitted are tracked per student/column. Overrides take precedence over calculated values.

### Calculations and expressions

- Column “renderers” use expression syntax documented at `docs.pawtograder.com` (link is available in the UI).
- Expressions have access to the calculated `score`; helper functions like `letter(score)` are supported.
- Referenced content: The UI shows links to referenced assignments and columns when a student’s value is derived from them.

### What‑If grades (student view)

- Students can simulate hypothetical grades on columns. The display clearly indicates when a What‑If value is shown and does not override actual grades.

### Managing the gradebook (instructors)

- Add/edit columns, set max scores, choose type (manual, assignment‑linked, calculated), define dependencies, and control release.
- Import columns and scores from CSV or external sources.
- Obfuscation mode and “only show grades for” filters help during staff reviews.

---

## Office Hours Queue

### Student experience

- Students create help requests tied to an assignment/submission file/line, or general course questions.
- They can add group members to a request.

### Staff tools (Office Hours page)

- Real‑time chat per request with rich features:
  - File references linked to submission files and specific line numbers
  - Quick status/assignment controls: assign to self, set in‑progress/resolved, add watchers
  - Feedback modal for post‑help survey
- Video calls:
  - Built on Amazon Chime. The browser requires HTTPS (the dev server uses a self‑signed certificate).
- Activity tracking:
  - The system logs key events (request updates/resolutions) per student for later summaries.

### Managing office hours (Manage → Office Hours)

- Queues dashboard: Create/edit queues, set visibility and scheduling.
- Templates: Create structured request templates per queue to collect consistent details.
- Moderation: Define actions (warnings, notes) and track student moderation status.
- Karma: Track student karma entries and view activity summaries.
- Feedback: Review help request feedback analytics.

---

## Discussions

- Organize by topics; threads support replies, likes, watches.
- Instructor dashboard highlights recent threads and activity.
- Moderation status can be applied to help keep discussions on track.

---

## Notifications

- Real‑time updates flow throughout the app (assignments, gradebook, OH queue, discussions).
- Staff can subscribe/watch threads and help requests to receive notifications.

---

## Roster and course management

- Manage → Course: Enrollments, lab sections, audit logs, flashcard decks, and email tools.
- Canvas and external integrations: Some flows can import users or data; see your course’s specific setup.

---

## GitHub integration

- Link your GitHub account (prompted in UI). For org‑backed courses:
  - Accept the organization invite; if needed, use “Resend Organization Invitation” in the Assignments area.
- Assignment repos:
  - Link a template repo; optionally auto‑provision student/group repos.
  - Workflow runs (Manage → Workflow Runs) help monitor CI status of autograding.

---

## Nuances and tips

- Time zone awareness: All due‑date and release displays are rendered in the course time zone.
- Groups and repositories: Group assignments will show one repo per group; membership is respected across submissions, grading, and the gradebook.
- Regrade lifecycle: Opened → resolved/closed. Keep the queue small by addressing or closing stale requests.
- Release discipline: Use dependencies to model your grading pipeline; release calculated columns only after inputs are released.
- Visibility: Use obfuscation mode while doing internal grade reviews.
- Real‑time behavior: Most lists (gradebook, OH queue, discussions) update live without page refresh.

---

## Troubleshooting

- GitHub access: If staff cannot see repos, verify their org membership and that their Pawtograder account is linked to GitHub.
- Time zone confusion: Confirm your course time zone in course settings; compare displays using course time.
- Video call problems: Ensure HTTPS and grant mic/camera permissions. If on localhost in dev, accept the self‑signed certificate.
- Missing student repos: Re‑run “Create Student Repos” after enrollment updates or group changes.

---

## Where to learn more

- Staff docs: `https://docs.pawtograder.com/staff/intro/`
- Developers: `https://docs.pawtograder.com/developers/intro/`
- Students: `https://docs.pawtograder.com/students/intro/`