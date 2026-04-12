"use client";

import type { GroupAnalytics, SurveyResponseWithContext } from "@/types/survey-analytics";
import { Box, HStack, Link, Text, VStack } from "@chakra-ui/react";
import { useMemo } from "react";
import { LuCheck, LuX } from "react-icons/lu";

type GroupMemberRosterProps = {
  group: GroupAnalytics;
  memberRows: SurveyResponseWithContext[];
  obfuscateStats?: boolean;
};

function EmailBesideName({ email, show }: { email: string | null | undefined; show: boolean }) {
  if (!show || !email?.trim()) return null;
  const trimmed = email.trim();
  return (
    <Link
      href={`mailto:${encodeURIComponent(trimmed)}`}
      fontSize="sm"
      colorPalette="blue"
      onClick={(e) => e.stopPropagation()}
    >
      {trimmed}
    </Link>
  );
}

export function GroupMemberRoster({ group, memberRows, obfuscateStats = false }: GroupMemberRosterProps) {
  const mentorEmail = memberRows[0]?.mentor_email ?? null;

  const students = useMemo(() => {
    const filtered = memberRows.filter((r) => {
      if (!group.mentorId) return true;
      return r.profile_id !== group.mentorId;
    });
    return [...filtered].sort((a, b) =>
      (a.profile_name ?? "").localeCompare(b.profile_name ?? "", undefined, { sensitivity: "base" })
    );
  }, [memberRows, group.mentorId]);

  const showEmails = !obfuscateStats;

  return (
    <Box borderWidth="1px" borderColor="border" borderRadius="md" p={4} bg="bg.subtle">
      <Text fontSize="sm" fontWeight="semibold" mb={3}>
        Group roster and submission status
      </Text>

      <VStack align="stretch" gap={4}>
        <Box>
          <Text fontSize="xs" fontWeight="medium" color="fg.muted" letterSpacing="0.04em" mb={1}>
            GROUP MENTOR
          </Text>
          <HStack align="baseline" flexWrap="wrap" gap={2}>
            {group.mentorName ? (
              <>
                <Text fontSize="sm" fontWeight="medium">
                  {obfuscateStats ? "Hidden" : group.mentorName}
                </Text>
                <EmailBesideName email={mentorEmail} show={showEmails} />
              </>
            ) : (
              <Text fontSize="sm" color="fg.muted">
                No mentor assigned
              </Text>
            )}
          </HStack>
        </Box>

        <Box>
          <Text fontSize="xs" fontWeight="medium" color="fg.muted" letterSpacing="0.04em" mb={2}>
            STUDENTS ({students.length})
          </Text>
          <VStack align="stretch" gap={2}>
            {students.map((r) => (
              <HStack key={r.profile_id} align="center" gap={3} flexWrap="wrap">
                <HStack gap={1} flexShrink={0} w="22px" justify="center">
                  {r.is_submitted ? (
                    <Box as="span" color="green.500" lineHeight={0} title="Submitted" aria-label="Submitted">
                      <LuCheck size={18} strokeWidth={2.5} />
                    </Box>
                  ) : (
                    <Box as="span" color="red.500" lineHeight={0} title="Not submitted" aria-label="Not submitted">
                      <LuX size={18} strokeWidth={2.5} />
                    </Box>
                  )}
                </HStack>
                <HStack align="baseline" flexWrap="wrap" gap={2} flex="1">
                  <Text fontSize="sm">{obfuscateStats ? "—" : (r.profile_name ?? "Unknown")}</Text>
                  <EmailBesideName email={r.profile_email} show={showEmails} />
                </HStack>
              </HStack>
            ))}
            {students.length === 0 && (
              <Text fontSize="sm" color="fg.muted">
                No students listed for this group.
              </Text>
            )}
          </VStack>
        </Box>
      </VStack>
    </Box>
  );
}
