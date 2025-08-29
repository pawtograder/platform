"use client";

import { Heading, HStack, Table, Text, VStack, Box, Skeleton } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
import { useCourse, useLateTokens, useRosterWithUserInfo } from "@/hooks/useCourseController";
import { createClient } from "@/utils/supabase/client";
import { AssignmentDueDateException } from "@/utils/supabase/DatabaseTypes";

type GroupMembersMap = Map<number, Set<string>>; // assignment_group_id -> set of profile_id

export default function RosterTokensTable() {
  const roster = useRosterWithUserInfo();
  const course = useCourse();
  const exceptions = useLateTokens();

  const [groupMembers, setGroupMembers] = useState<GroupMembersMap>(new Map());
  const [loadingGroups, setLoadingGroups] = useState<boolean>(true);

  // Fetch all assignment group memberships for this class once (used to attribute group exceptions to students)
  // I don't think this needs to be realtime
  useEffect(() => {
    let cancelled = false;
    const id = course?.id;
    if (!id) {
      setLoadingGroups(false);
      return () => {
        cancelled = true;
      };
    }
    const fetchGroupMembers = async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("assignment_groups_members")
          .select("assignment_group_id, profile_id")
          .eq("class_id", id);
        if (error) throw error;
        if (cancelled) return;
        const map: GroupMembersMap = new Map();
        (data || []).forEach((row) => {
          const agid = row.assignment_group_id as number;
          const pid = row.profile_id as string;
          if (!map.has(agid)) map.set(agid, new Set());
          map.get(agid)!.add(pid);
        });
        setGroupMembers(map);
      } catch (e) {
        console.error("Failed to fetch assignment group members", e);
      } finally {
        if (!cancelled) setLoadingGroups(false);
      }
    };
    fetchGroupMembers();
    return () => {
      cancelled = true;
    };
  }, [course?.id]);
  // Compute tokens used and gifted per student
  const tokensByStudent = useMemo(() => {
    const usedMap = new Map<string, { used: number; gifted: number }>();

    const addTo = (studentId: string, tokensConsumed: number) => {
      const entry = usedMap.get(studentId) || { used: 0, gifted: 0 };
      if (tokensConsumed > 0) entry.used += tokensConsumed;
      else if (tokensConsumed < 0) entry.gifted += -tokensConsumed; // store positive gifted count
      usedMap.set(studentId, entry);
    };

    const all: AssignmentDueDateException[] = exceptions || [];
    for (const ex of all) {
      // Direct student exception
      if (ex.student_id) {
        addTo(ex.student_id, ex.tokens_consumed || 0);
        continue;
      }
      // Group exception -> attribute to all members of the assignment group
      if (ex.assignment_group_id != null) {
        const members = groupMembers.get(ex.assignment_group_id) || new Set<string>();
        if (members.size > 0) {
          members.forEach((pid) => addTo(pid, ex.tokens_consumed || 0));
        }
      }
    }

    return usedMap;
  }, [exceptions, groupMembers]);

  const rows = useMemo(() => {
    const perStudentDefault = (pid: string) => tokensByStudent.get(pid) || { used: 0, gifted: 0 };
    return (roster || [])
      .filter((r) => r.role === "student")
      .map((r) => {
        const pid = r.private_profile_id as string;
        const counts = perStudentDefault(pid);
        const totalAllocation = (course?.late_tokens_per_student || 0) + counts.gifted;
        const left = Math.max(0, totalAllocation - counts.used);
        return {
          id: pid,
          email: (r.users && typeof r.users.email === "string" ? r.users.email : "") || "",
          used: counts.used,
          left,
          gifted: counts.gifted
        };
      })
      .sort((a, b) => a.email.localeCompare(b.email));
  }, [roster, tokensByStudent, course?.late_tokens_per_student]);

  const isLoading = !roster || !exceptions || loadingGroups;

  return (
    <VStack align="stretch" gap={4} w="100%">
      <HStack justifyContent="space-between">
        <Heading size="md">Roster Tokens</Heading>
        <Text fontSize="sm" color="fg.muted">
          {(() => {
            const base = course?.late_tokens_per_student ?? 0;
            return (
              <>
                Each student receives {base} late token{base !== 1 ? "s" : ""}
              </>
            );
          })()}
        </Text>
      </HStack>

      <Box>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader minW="220px">Student Email</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="right">Used</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="right">Left</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {isLoading && (
              <Table.Row>
                <Table.Cell colSpan={3}>
                  <Skeleton height="20px" />
                </Table.Cell>
              </Table.Row>
            )}
            {!isLoading && rows.length === 0 && (
              <Table.Row>
                <Table.Cell colSpan={3}>
                  <Text color="fg.muted">No students found.</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {!isLoading &&
              rows.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    <Text>{row.email || row.id}</Text>
                  </Table.Cell>
                  <Table.Cell textAlign="right">{row.used}</Table.Cell>
                  <Table.Cell textAlign="right">{row.left}</Table.Cell>
                </Table.Row>
              ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </VStack>
  );
}
