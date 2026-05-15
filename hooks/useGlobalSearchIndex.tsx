"use client";

import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useAssignments,
  useDiscussionThreadTeasers,
  useDiscussionTopics,
  usePublishedSurveys
} from "@/hooks/useCourseController";
import { COURSE_FEATURES, courseFeatureEffectiveEnabled, type CourseFeatureName } from "@/lib/courseFeatures";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import * as React from "react";

export type SearchHitKind = "page" | "assignment" | "survey" | "discussion" | "setting";

export type SearchHit = {
  id: string;
  kind: SearchHitKind;
  title: string;
  subtitle?: string;
  url: string;
  /** Extra strings searched alongside title/subtitle. */
  keywords?: string[];
  /** Higher = better. Tie-broken by title match position. */
  rank?: number;
};

type StaticPage = {
  label: string;
  href: (courseId: number) => string;
  feature?: CourseFeatureName;
  defaultEnabled?: boolean;
  /** Only for instructors/graders. */
  staffOnly?: boolean;
};

const STATIC_PAGES: StaticPage[] = [
  { label: "Course dashboard", href: (c) => `/course/${c}` },
  { label: "Assignments", href: (c) => `/course/${c}/assignments` },
  {
    label: "Gradebook",
    href: (c) => `/course/${c}/gradebook`,
    feature: COURSE_FEATURES.GRADEBOOK,
    defaultEnabled: true
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
  { label: "My regrade requests", href: (c) => `/course/${c}/regrade-requests` }
];

const STAFF_STATIC_PAGES: StaticPage[] = [
  { label: "Manage assignments", href: (c) => `/course/${c}/manage/assignments`, staffOnly: true },
  {
    label: "Manage gradebook",
    href: (c) => `/course/${c}/manage/gradebook`,
    feature: COURSE_FEATURES.GRADEBOOK,
    defaultEnabled: true,
    staffOnly: true
  },
  { label: "Manage office hours", href: (c) => `/course/${c}/manage/office-hours`, staffOnly: true },
  { label: "Course settings", href: (c) => `/course/${c}/manage/course`, staffOnly: true },
  { label: "Enrollments", href: (c) => `/course/${c}/manage/course/enrollments`, staffOnly: true },
  { label: "Feature flags", href: (c) => `/course/${c}/manage/course/feature-flags`, staffOnly: true },
  { label: "Audit log", href: (c) => `/course/${c}/manage/course/audit`, staffOnly: true },
  { label: "Workflow runs", href: (c) => `/course/${c}/manage/workflow-runs`, staffOnly: true }
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
  const courseId = role?.class_id ?? 0;
  const isStaff = role?.role === "instructor" || role?.role === "grader";
  const rawFeatures = (role?.classes as Partial<CourseWithFeatures> | undefined)?.features;
  const features = React.useMemo(() => (Array.isArray(rawFeatures) ? rawFeatures : []), [rawFeatures]);

  const assignments = useAssignments();
  const { surveys } = usePublishedSurveys();
  const threads = useDiscussionThreadTeasers();
  const topics = useDiscussionTopics();

  return React.useMemo<SearchHit[]>(() => {
    if (!courseId) return [];

    const isFeatureOn = (feature: CourseFeatureName | undefined, def = true) => {
      if (!feature) return true;
      return courseFeatureEffectiveEnabled(features, feature, def);
    };

    const out: SearchHit[] = [];

    for (const page of STATIC_PAGES) {
      if (!isFeatureOn(page.feature, page.defaultEnabled ?? true)) continue;
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
      out.push({
        id: `assignment:${a.id}`,
        kind: "assignment",
        title: a.title,
        subtitle: a.slug ?? undefined,
        url: `/course/${courseId}/assignments/${a.id}`,
        keywords: a.slug ? [a.slug] : undefined
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
      // Only root threads (replies aren't usefully addressable).
      for (const t of threads) {
        if (t.draft) continue;
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

    return out;
  }, [assignments, courseId, features, isStaff, surveys, threads, topics]);
}

const PER_GROUP_CAP = 8;
const TOTAL_CAP = 40;

export type SearchHitGroup = { kind: SearchHitKind; label: string; hits: SearchHit[] };

const GROUP_ORDER: { kind: SearchHitKind; label: string }[] = [
  { kind: "assignment", label: "Assignments" },
  { kind: "survey", label: "Surveys" },
  { kind: "discussion", label: "Discussion" },
  { kind: "page", label: "Pages" },
  { kind: "setting", label: "Settings" }
];

export function filterSearchIndex(index: SearchHit[], rawQuery: string): SearchHitGroup[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    // Empty query: surface only pages so the palette is useful as a launcher.
    const pageHits = index.filter((h) => h.kind === "page" || h.kind === "setting").slice(0, TOTAL_CAP);
    return groupHits(pageHits);
  }
  const words = q.split(/\s+/).filter(Boolean);
  const matches: { hit: SearchHit; rank: number }[] = [];
  for (const hit of index) {
    const title = hit.title.toLowerCase();
    const subtitle = (hit.subtitle ?? "").toLowerCase();
    const keywords = (hit.keywords ?? []).map((k) => k.toLowerCase());
    let titleHits = 0;
    let subtitleHits = 0;
    let keywordHits = 0;
    let missing = false;
    for (const w of words) {
      const inTitle = title.includes(w);
      const inSub = subtitle.includes(w);
      const inKw = keywords.some((k) => k.includes(w));
      if (!inTitle && !inSub && !inKw) {
        missing = true;
        break;
      }
      if (inTitle) titleHits++;
      else if (inSub) subtitleHits++;
      else keywordHits++;
    }
    if (missing) continue;
    // Title matches outweigh subtitle, subtitle outweighs keywords.
    const rank = titleHits * 6 + subtitleHits * 2 + keywordHits * 1;
    matches.push({ hit, rank });
  }
  matches.sort((a, b) => b.rank - a.rank || a.hit.title.localeCompare(b.hit.title));
  return groupHits(
    matches.map((m) => m.hit),
    PER_GROUP_CAP,
    TOTAL_CAP
  );
}

function groupHits(hits: SearchHit[], perGroup: number = PER_GROUP_CAP, total: number = TOTAL_CAP): SearchHitGroup[] {
  const groups: SearchHitGroup[] = GROUP_ORDER.map((g) => ({ ...g, hits: [] }));
  let used = 0;
  for (const hit of hits) {
    if (used >= total) break;
    const group = groups.find((g) => g.kind === hit.kind);
    if (!group) continue;
    if (group.hits.length >= perGroup) continue;
    group.hits.push(hit);
    used++;
  }
  return groups.filter((g) => g.hits.length > 0);
}
