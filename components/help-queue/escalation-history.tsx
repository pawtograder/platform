"use client";

import { useUserProfile } from "@/hooks/useUserProfiles";
import { useEscalationsForRequest, useWorkSessionsForRequest } from "@/hooks/useOfficeHoursRealtime";
import { formatWaitDuration, totalQueueWaitMs } from "@/lib/helpRequestEscalation";
import { HelpRequest, HelpRequestEscalation } from "@/utils/supabase/DatabaseTypes";
import { Box, DataList, Heading, Stack, Text } from "@chakra-ui/react";
import { format } from "date-fns";
import { useMemo } from "react";

function ProfileName({ id }: { id: string | null }) {
  const profile = useUserProfile(id);
  return <>{profile?.name ?? "Unknown"}</>;
}

function EscalationEntry({ escalation, index }: { escalation: HelpRequestEscalation; index: number }) {
  return (
    <Box as="li" borderStartWidth="2px" borderColor="purple.solid" ps="3">
      <Text fontSize="xs" color="fg.muted">
        #{index + 1} · {format(new Date(escalation.created_at), "MMM d, h:mm a")} ·{" "}
        {escalation.source === "student" ? (
          <>
            Student after help from <ProfileName id={escalation.previous_assignee} />
          </>
        ) : (
          <>
            Escalated by <ProfileName id={escalation.escalated_by} />
          </>
        )}
      </Text>
      <Text fontSize="sm" whiteSpace="pre-wrap">
        {escalation.note}
      </Text>
    </Box>
  );
}

/**
 * Staff-only context for an escalated ticket: who already helped, how long the student has waited in
 * line, and every escalation note, so the student does not have to explain the problem again.
 */
export function EscalationHistory({ request }: { request: HelpRequest }) {
  const escalations = useEscalationsForRequest(request.id);
  const workSessions = useWorkSessionsForRequest(request.id);

  const helperIds = useMemo(
    () =>
      Array.from(
        new Set(
          [...workSessions]
            .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
            .map((s) => s.ta_profile_id)
        )
      ),
    [workSessions]
  );
  const waitedMs = totalQueueWaitMs(request, workSessions, escalations);

  if (request.escalation_count === 0) return null;

  return (
    <Box
      borderWidth="1px"
      borderColor="purple.muted"
      bg="purple.subtle"
      rounded="md"
      p="4"
      role="region"
      aria-label="Escalation history"
    >
      <Heading size="sm" mb="3">
        Escalation history
      </Heading>
      <DataList.Root orientation="horizontal" size="sm" mb="4">
        <DataList.Item>
          <DataList.ItemLabel>Helped by</DataList.ItemLabel>
          <DataList.ItemValue>
            {helperIds.length === 0
              ? "Nobody yet"
              : helperIds.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <ProfileName id={id} />
                  </span>
                ))}
          </DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel>Time waited in line</DataList.ItemLabel>
          <DataList.ItemValue>{formatWaitDuration(waitedMs)}</DataList.ItemValue>
        </DataList.Item>
        <DataList.Item>
          <DataList.ItemLabel>Escalations</DataList.ItemLabel>
          <DataList.ItemValue>{request.escalation_count}</DataList.ItemValue>
        </DataList.Item>
      </DataList.Root>
      <Stack gap="3" as="ol" listStyleType="none">
        {escalations.map((e, i) => (
          <EscalationEntry key={e.id} escalation={e} index={i} />
        ))}
      </Stack>
    </Box>
  );
}
