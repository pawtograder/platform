"use client";

import { useClassProfiles, useIsGraderOrInstructor, useIsInstructor } from "@/hooks/useClassProfiles";
import { useViewAsStudentDataMask } from "@/hooks/useViewAsStudentDataMask";
import {
  useAssignments,
  useCourse,
  useDiscussionThreadTeasers,
  useDiscussionTopics,
  usePublishedSurveys
} from "@/hooks/useCourseController";
import { useHelpQueues } from "@/hooks/useOfficeHoursRealtime";
import { COURSE_FEATURES, courseFeatureEffectiveEnabled, type CourseFeatureName } from "@/lib/courseFeatures";
import type { SearchHit } from "@/lib/searchIndex";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import * as React from "react";

export { filterSearchIndex } from "@/lib/searchIndex";
export type { SearchHit, SearchHitGroup, SearchHitKind } from "@/lib/searchIndex";

/**
 * Who should see a given navigation entry. "both" (the default) shows the
 * entry to every enrolled user. "student" / "staff" restrict to the matching
 * role so the palette stops surfacing student-only screens (e.g. "My regrade
 * requests") to instructors and vice-versa.
 */
type Audience = "student" | "staff" | "both";

type StaticPage = {
  label: string;
  href: (courseId: number) => string;
  feature?: CourseFeatureName;
  defaultEnabled?: boolean;
  audience?: Audience;
};

const STATIC_PAGES: StaticPage[] = [
  { label: "Course dashboard", href: (c) => `/course/${c}` },
  { label: "Assignments", href: (c) => `/course/${c}/assignments`, audience: "student" },
  {
    label: "Gradebook",
    href: (c) => `/course/${c}/gradebook`,
    feature: COURSE_FEATURES.GRADEBOOK,
    defaultEnabled: true,
    audience: "student"
  },
  {
    label: "Office hours",
    href: (c) => `/course/${c}/office-hours`,
    feature: COURSE_FEATURES.OFFICE_HOURS,
    defaultEnabled: true
  },
  {
    label: "Discussion",
    href: (c) => `/course/${c}/discussion`,
    feature: COURSE_FEATURES.DISCUSSION,
    defaultEnabled: true
  },
  {
    label: "Surveys",
    href: (c) => `/course/${c}/surveys`,
    feature: COURSE_FEATURES.SURVEYS,
    defaultEnabled: true
  },
  {
    label: "Polls",
    href: (c) => `/course/${c}/polls`,
    feature: COURSE_FEATURES.POLLS,
    defaultEnabled: true
  },
  {
    label: "Flashcards",
    href: (c) => `/course/${c}/flashcards`,
    feature: COURSE_FEATURES.FLASHCARDS,
    defaultEnabled: true
  },
  { label: "GitHub help", href: (c) => `/course/${c}/github-help` },
  { label: "Notifications", href: (c) => `/course/${c}/notifications` },
  { label: "My regrade requests", href: (c) => `/course/${c}/regrade-requests`, audience: "student" }
];

const STAFF_STATIC_PAGES: StaticPage[] = [
  { label: "Manage assignments", href: (c) => `/course/${c}/manage/assignments`, audience: "staff" },
  {
    label: "Manage gradebook",
    href: (c) => `/course/${c}/manage/gradebook`,
    feature: COURSE_FEATURES.GRADEBOOK,
    defaultEnabled: true,
    audience: "staff"
  },
  { label: "Manage office hours", href: (c) => `/course/${c}/manage/office-hours`, audience: "staff" },
  {
    label: "Manage regrade requests",
    href: (c) => `/course/${c}/manage/regrade-requests`,
    audience: "staff"
  },
  { label: "Course settings", href: (c) => `/course/${c}/manage/course`, audience: "staff" },
  { label: "Enrollments", href: (c) => `/course/${c}/manage/course/enrollments`, audience: "staff" },
  { label: "Feature flags", href: (c) => `/course/${c}/manage/course/feature-flags`, audience: "staff" },
  { label: "Audit log", href: (c) => `/course/${c}/manage/course/audit`, audience: "staff" },
  { label: "Workflow runs", href: (c) => `/course/${c}/manage/workflow-runs`, audience: "staff" }
];

/**
 * Sub-pages exposed when an instructor or grader picks an assignment from
 * the palette. Mirrors the side nav in `ManageAssignmentNav` so muscle
 * memory carries over. Keep `graderOk: true` for entries graders can see.
 */
const ASSIGNMENT_STAFF_SUBPAGES: { label: string; path: string; graderOk?: boolean; instructorOnly?: boolean }[] = [
  { label: "Assignment Home", path: "", graderOk: true },
  { label: "Edit Assignment", path: "/edit", instructorOnly: true },
  { label: "Configure Autograder", path: "/autograder", instructorOnly: true },
  { label: "Configure Rubric", path: "/rubric", instructorOnly: true },
  { label: "Test Assignment", path: "/test", graderOk: true },
  { label: "Repository Status", path: "/repositories", instructorOnly: true },
  { label: "Rerun Autograder", path: "/rerun-autograder", instructorOnly: true },
  { label: "Manage Due Date Exceptions", path: "/due-date-exceptions", graderOk: true },
  { label: "Grading Assignments", path: "/reviews", graderOk: true },
  { label: "Manage Groups", path: "/groups", graderOk: true },
  { label: "Manage Regrade Requests", path: "/regrade-requests", graderOk: true },
  { label: "Security Audit", path: "/security", instructorOnly: true },
  { label: "Test Insights", path: "/test-insights", graderOk: true }
];

/**
 * In-memory unified search index. Subscribes to the existing course
 * controllers and produces a flat array of SearchHit. Filtering happens
 * client-side via {@link filterSearchIndex} (debounced by the caller).
 *
 * Out of scope here: server-side full-text search across content the
 * controllers don't preload (discussion bodies older than the loaded
 * window, submission files). The hook is shaped so an RPC fallback can
 * fan out behind {@link filterSearchIndex} in a future pass without
 * changing the consumer surface.
 */
export function useGlobalSearchIndex(): SearchHit[] {
  const { role } = useClassProfiles();
  const { filterDiscussionTeaser } = useViewAsStudentDataMask();
  const course = useCourse();
  const courseId = role?.class_id ?? 0;
  const isInstructor = useIsInstructor();
  const isStaff = useIsGraderOrInstructor();
  const rawFeatures = (course as Partial<CourseWithFeatures> | undefined)?.features;
  const features = React.useMemo(() => (Array.isArray(rawFeatures) ? rawFeatures : []), [rawFeatures]);

  const assignments = useAssignments();
  const { surveys } = usePublishedSurveys();
  const threads = useDiscussionThreadTeasers();
  const topics = useDiscussionTopics();
  const helpQueues = useHelpQueues();

  return React.useMemo<SearchHit[]>(() => {
    if (!courseId) return [];

    const isFeatureOn = (feature: CourseFeatureName | undefined, def = true) => {
      if (!feature) return true;
      return courseFeatureEffectiveEnabled(features, feature, def);
    };

    const audienceAllows = (audience: Audience | undefined) => {
      const aud = audience ?? "both";
      if (aud === "both") return true;
      if (aud === "staff") return isStaff;
      return !isStaff;
    };

    const out: SearchHit[] = [];

    for (const page of STATIC_PAGES) {
      if (!isFeatureOn(page.feature, page.defaultEnabled ?? true)) continue;
      if (!audienceAllows(page.audience)) continue;
      out.push({
        id: `page:${page.label}`,
        kind: "page",
        title: page.label,
        url: page.href(courseId)
      });
    }
    if (isStaff) {
      for (const page of STAFF_STATIC_PAGES) {
        if (!isFeatureOn(page.feature, page.defaultEnabled ?? true)) continue;
        if (!audienceAllows(page.audience)) continue;
        out.push({
          id: `setting:${page.label}`,
          kind: "setting",
          title: page.label,
          url: page.href(courseId)
        });
      }
    }

    for (const a of assignments) {
      if (!a.title) continue;
      const studentUrl = `/course/${courseId}/assignments/${a.id}`;
      const manageBase = `/course/${courseId}/manage/assignments/${a.id}`;
      // Instructors/graders land on the manage view by default and get a
      // nested chooser of assignment sub-pages (edit rubric, grading, etc.).
      // Students go straight to the student-facing assignment page.
      let children: SearchHit[] | undefined;
      if (isStaff) {
        children = ASSIGNMENT_STAFF_SUBPAGES.filter((sp) => {
          if (sp.instructorOnly) return isInstructor;
          // graderOk (or unset) is visible to both instructors and graders
          return true;
        }).map((sp) => ({
          id: `assignment:${a.id}:${sp.path || "home"}`,
          kind: "assignment" as const,
          title: sp.label,
          subtitle: a.title ?? undefined,
          url: `${manageBase}${sp.path}`
        }));
      }
      out.push({
        id: `assignment:${a.id}`,
        kind: "assignment",
        title: a.title,
        subtitle: a.slug ?? undefined,
        url: isStaff ? manageBase : studentUrl,
        keywords: a.slug ? [a.slug] : undefined,
        children
      });
    }

    if (isFeatureOn(COURSE_FEATURES.SURVEYS)) {
      for (const s of surveys) {
        out.push({
          id: `survey:${s.id}`,
          kind: "survey",
          title: s.title ?? "Untitled survey",
          subtitle: s.description ?? undefined,
          url: `/course/${courseId}/surveys/${s.id}`
        });
      }
    }

    if (isFeatureOn(COURSE_FEATURES.DISCUSSION)) {
      // Discussion topics jump straight into the browse view filtered to
      // that topic. Useful as a top-level launcher even when there are no
      // threads yet.
      for (const t of topics) {
        if (!t.topic) continue;
        out.push({
          id: `discussion-topic:${t.id}`,
          kind: "discussion-topic",
          title: t.topic,
          subtitle: t.description ?? undefined,
          url: `/course/${courseId}/discussion?view=browse&topic=${t.id}`,
          keywords: t.description ? [t.description] : undefined
        });
      }

      // Only root threads (replies aren't usefully addressable).
      for (const t of threads) {
        if (t.draft) continue;
        if (!filterDiscussionTeaser(t)) continue;
        const topic = topics.find((tp) => tp.id === t.topic_id);
        out.push({
          id: `discussion:${t.id}`,
          kind: "discussion",
          title: t.subject ?? "Untitled thread",
          subtitle: topic?.topic ?? undefined,
          url: `/course/${courseId}/discussion/${t.id}`,
          keywords: t.body ? [t.body] : undefined
        });
      }
    }

    if (isFeatureOn(COURSE_FEATURES.OFFICE_HOURS)) {
      for (const q of helpQueues) {
        // Hide unavailable queues from students; staff still need to manage
        // them so leave them visible.
        if (!isStaff && q.available === false) continue;
        out.push({
          id: `help-queue:${q.id}`,
          kind: "help-queue",
          title: q.name ?? "Help queue",
          subtitle: q.description ?? undefined,
          url: `/course/${courseId}/office-hours/${q.id}`,
          keywords: ["office hours", "help"]
        });
      }
    }

    return out;
  }, [
    assignments,
    courseId,
    features,
    filterDiscussionTeaser,
    helpQueues,
    isInstructor,
    isStaff,
    surveys,
    threads,
    topics
  ]);
}
