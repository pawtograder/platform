"use client";

import Link from "@/components/ui/link";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { COURSE_FEATURES, courseFeatureEffectiveEnabled, type CourseFeatureName } from "@/lib/courseFeatures";
import { CourseWithFeatures } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Text } from "@chakra-ui/react";
import { FiBookOpen, FiCheckSquare, FiCompass, FiFileText, FiMessageSquare, FiStar } from "react-icons/fi";

/**
 * Audit-flagged: dashboard had no direct links to most course sections,
 * forcing students through the top nav. This is a curb-cut nav row that
 * surfaces every feature-enabled course area inline on the dashboard.
 *
 * Renders nothing when no features are enabled (so platforms with a
 * pared-down course config don't show an empty strip).
 */
type LinkSpec = {
  feature: CourseFeatureName | null;
  href: (courseId: number) => string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  defaultWhenMissing: boolean;
};

const LINKS: LinkSpec[] = [
  {
    feature: null,
    href: (c) => `/course/${c}/assignments`,
    label: "Assignments",
    icon: FiCompass,
    defaultWhenMissing: true
  },
  {
    feature: COURSE_FEATURES.GRADEBOOK,
    href: (c) => `/course/${c}/gradebook`,
    label: "Gradebook",
    icon: FiBookOpen,
    defaultWhenMissing: true
  },
  {
    feature: COURSE_FEATURES.OFFICE_HOURS,
    href: (c) => `/course/${c}/office-hours`,
    label: "Office Hours",
    icon: FiMessageSquare,
    defaultWhenMissing: true
  },
  {
    feature: COURSE_FEATURES.DISCUSSION,
    href: (c) => `/course/${c}/discussion`,
    label: "Discussion",
    icon: FiStar,
    defaultWhenMissing: true
  },
  {
    feature: COURSE_FEATURES.SURVEYS,
    href: (c) => `/course/${c}/surveys`,
    label: "Surveys",
    icon: FiFileText,
    defaultWhenMissing: true
  },
  {
    feature: COURSE_FEATURES.POLLS,
    href: (c) => `/course/${c}/polls`,
    label: "Polls",
    icon: FiCheckSquare,
    defaultWhenMissing: true
  }
];

export function DashboardQuickLinks() {
  const { role } = useClassProfiles();
  const courseId = role?.class_id;
  // Features live on classes.features via the role join; narrow safely.
  const features = (role?.classes as Partial<CourseWithFeatures> | undefined)?.features ?? [];

  if (!courseId) return null;

  const visible = LINKS.filter((link) => {
    if (!link.feature) return true;
    return courseFeatureEffectiveEnabled(features, link.feature, link.defaultWhenMissing);
  });

  if (visible.length === 0) return null;

  return (
    <Box as="nav" aria-label="Jump to course section" mb={3}>
      <Text fontSize="xs" color="fg.muted" mb={1}>
        Jump to
      </Text>
      <HStack flexWrap="wrap" gap={2}>
        {visible.map(({ href, label, icon: Icon }) => (
          <Link
            key={label}
            href={href(courseId)}
            variant="plain"
            display="inline-flex"
            alignItems="center"
            gap={1.5}
            px={3}
            py={1.5}
            borderRadius="md"
            borderWidth="1px"
            borderColor="border.emphasized"
            fontSize="sm"
            bg="bg.subtle"
            _hover={{ bg: "bg.muted", textDecoration: "none" }}
          >
            <Icon size={14} />
            {label}
          </Link>
        ))}
      </HStack>
    </Box>
  );
}
