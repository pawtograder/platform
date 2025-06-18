import Markdown from "@/components/ui/markdown";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useGradebookColumns,
  useGradebookColumnStudent,
  useGradebookController,
  useReferencedContent
} from "@/hooks/useGradebook";
import { GradebookWhatIfProvider, useGradebookWhatIf, useWhatIfGrade } from "@/hooks/useGradebookWhatIf";
import { GradebookColumn } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Card, Code, Heading, HStack, Input, Text, VStack } from "@chakra-ui/react";
import { useState } from "react";

function WhatIfScoreCell({
  column,
  private_profile_id,
  isEditing,
  setIsEditing
}: {
  column: GradebookColumn;
  private_profile_id: string;
  isEditing: boolean;
  setIsEditing: (isEditing: boolean) => void;
}) {
  const renderer = useGradebookController().getRendererForColumn(column.id);
  const studentGrade = useGradebookColumnStudent(column.id, private_profile_id);
  const whatIfVal = useWhatIfGrade(column.id);
  const whatIfController = useGradebookWhatIf();
  const score = studentGrade?.score_override ?? studentGrade?.score;
  if (isEditing) {
    return (
      <Box display="flex" flexDirection="column" alignItems="center">
        <Input
          minW="5em"
          autoFocus
          type="number"
          value={whatIfVal === undefined ? "" : whatIfVal}
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Number(e.target.value.trim());
            whatIfController.setGrade(column.id, v);
          }}
          onBlur={() => setIsEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setIsEditing(false);
            }
          }}
        />
        <Text fontSize="sm" color="fg.muted">
          What If?
        </Text>
      </Box>
    );
  }
  const isShowingWhatIf = whatIfVal !== undefined && whatIfVal !== score;
  return (
    <HStack flexShrink={0} minW="fit-content" gap={0} pr={2}>
      {column.render_expression && (
        <Box pr={2}>
          {renderer(
            isShowingWhatIf
              ? {
                  score: whatIfVal ?? null,
                  score_override: null,
                  is_missing: false,
                  is_excused: false,
                  is_droppable: false,
                  released: false
                }
              : (studentGrade ?? {
                  score: null,
                  score_override: null,
                  is_missing: false,
                  is_excused: false,
                  is_droppable: false,
                  released: false
                })
          )}
        </Box>
      )}
      {column.render_expression && "("}
      {isShowingWhatIf ? Math.round(whatIfVal) : score === undefined || score === null ? "missing" : Math.round(score)}
      <Text minW="fit-content">{column.max_score && `/${column.max_score}`}</Text>
      {column.render_expression && ")"}
    </HStack>
  );
}

function canEditColumn(column: GradebookColumn) {
  const deps = column.dependencies;
  return !(
    deps &&
    typeof deps === "object" &&
    "gradebook_columns" in deps &&
    Array.isArray((deps as { gradebook_columns?: number[] }).gradebook_columns) &&
    (deps as { gradebook_columns?: number[] }).gradebook_columns!.length > 0
  );
}

export default function WhatIfPage() {
  const { private_profile_id } = useClassProfiles();
  return (
    <GradebookWhatIfProvider private_profile_id={private_profile_id}>
      <WhatIf private_profile_id={private_profile_id} />
    </GradebookWhatIfProvider>
  );
}

function GradebookCard({ column, private_profile_id }: { column: GradebookColumn; private_profile_id: string }) {
  const [isEditing, setIsEditing] = useState(false);
  const whatIfVal = useWhatIfGrade(column.id);
  const studentGrade = useGradebookColumnStudent(column.id, private_profile_id);
  const score = studentGrade?.score_override ?? studentGrade?.score;
  const isShowingWhatIf = whatIfVal !== undefined && whatIfVal !== score;
  const canEdit = canEditColumn(column);
  const whatIfController = useGradebookWhatIf();
  const referencedContent = useReferencedContent(column.id, private_profile_id);

  return (
    <Card.Root
      key={column.id}
      w="100%"
      bg={isShowingWhatIf ? "bg.info" : undefined}
      justifyContent="space-between"
      cursor={canEdit ? "pointer" : "default"}
      display="flex"
      onClick={canEdit ? () => setIsEditing(true) : undefined}
      textAlign="left"
    >
      <HStack align="top">
        <Card.Header flexGrow={10} p={2}>
          <VStack align="left" maxW="md">
            <Heading size="sm">{column.name}</Heading>
            <Markdown style={{ fontSize: "0.8rem" }}>{column.description}</Markdown>
            {column.score_expression && (
              <Box>
                <Text fontSize="sm" color="fg.muted">
                  Calculated as:
                </Text>{" "}
                <Code>{column.score_expression}</Code>
              </Box>
            )}
            {referencedContent && <Box style={{ fontSize: "0.8rem" }}>{referencedContent}</Box>}
          </VStack>
        </Card.Header>
        <Card.Body p={2}>
          <WhatIfScoreCell
            column={column}
            private_profile_id={private_profile_id}
            isEditing={isEditing}
            setIsEditing={setIsEditing}
          />
        </Card.Body>
      </HStack>
      <Card.Footer p={2} textAlign="right" display="flex" justifyContent="flex-end">
        <VStack align="flex-end">
          {canEdit && !isShowingWhatIf && (
            <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
              What if?
            </Button>
          )}
          {canEdit && isShowingWhatIf && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                whatIfController.setGrade(column.id, undefined);
                setIsEditing(false);
              }}
            >
              Reset
            </Button>
          )}
          {!canEdit && (
            <Text fontSize="sm" color="fg.muted">
              This column is auto-calculated.
            </Text>
          )}

          {isShowingWhatIf && (
            <Text fontWeight="bold" color="fg.info">
              This value is hypothetical, based on the current &quot;What If?&quot; simulation.
            </Text>
          )}
        </VStack>
      </Card.Footer>
    </Card.Root>
  );
}
export function WhatIf({ private_profile_id }: { private_profile_id: string }) {
  const columns = useGradebookColumns();
  columns.sort((a, b) => a.sort_order - b.sort_order);
  return (
    <GradebookWhatIfProvider private_profile_id={private_profile_id}>
      <VStack minW="md" maxW="xl" align="flex-start">
        {columns.map((column) => (
          <GradebookCard key={column.id} column={column} private_profile_id={private_profile_id} />
        ))}
      </VStack>
    </GradebookWhatIfProvider>
  );
}
