"use client";

import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { useSurveySeries, useSurveysInSeries } from "@/hooks/useCourseController";
import type { SurveySeriesRow } from "@/types/survey-analytics";
import { createClient } from "@/utils/supabase/client";
import { Badge, Card, Collapsible, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useState } from "react";
import { BsChevronDown, BsChevronRight, BsPencil, BsTrash } from "react-icons/bs";

type SurveySeriesListProps = {
  classId: number;
  onEditSeries: (series: SurveySeriesRow) => void;
  onDeleteSeries: (seriesId: string) => void;
};

export default function SurveySeriesList({ classId, onEditSeries, onDeleteSeries }: SurveySeriesListProps) {
  const { series, isLoading, refetch } = useSurveySeries();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleDelete = (seriesId: string) => {
    onDeleteSeries(seriesId);
    refetch();
  };

  if (isLoading) {
    return <Text color="fg.muted">Loading series...</Text>;
  }

  if (!series || series.length === 0) {
    return <Text color="fg.muted">No survey series yet. Create one to link surveys for trend analysis.</Text>;
  }

  return (
    <VStack align="stretch" gap={4}>
      {series.map((s) => (
        <SeriesCard
          key={s.id}
          series={s}
          classId={classId}
          isExpanded={expandedId === s.id}
          onToggle={() => setExpandedId((prev) => (prev === s.id ? null : s.id))}
          onEdit={() => onEditSeries(s as SurveySeriesRow)}
          onDelete={() => handleDelete(s.id)}
        />
      ))}
    </VStack>
  );
}

type SeriesCardProps = {
  series: { id: string; name: string; description: string | null };
  classId: number;
  isExpanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function SeriesCard({ series, isExpanded, onToggle, onEdit, onDelete }: SeriesCardProps) {
  const { surveys, isLoading } = useSurveysInSeries(series.id);

  const handleDeleteClick = async () => {
    if (!confirm(`Delete series "${series.name}"? Surveys will be unlinked but not deleted.`)) return;
    const supabase = createClient();
    const { error } = await supabase.from("survey_series").delete().eq("id", series.id);
    if (error) {
      toaster.error({ title: "Error", description: error.message });
      return;
    }
    toaster.success({ title: "Success", description: "Series deleted" });
    onDelete();
  };

  return (
    <Card.Root>
      <Card.Header cursor="pointer" onClick={onToggle} _hover={{ bg: "bg.subtle" }} transition="background 0.15s">
        <HStack justify="space-between" flex={1}>
          <HStack gap={2}>
            <Icon as={isExpanded ? BsChevronDown : BsChevronRight} boxSize={4} />
            <Text fontWeight="semibold">{series.name}</Text>
            <Badge size="sm" colorPalette="blue">
              {isLoading ? "…" : surveys.length} survey{surveys.length !== 1 ? "s" : ""}
            </Badge>
          </HStack>
          <HStack gap={2} onClick={(e) => e.stopPropagation()}>
            <Button size="xs" variant="ghost" onClick={onEdit}>
              <Icon as={BsPencil} />
            </Button>
            <Button size="xs" variant="ghost" colorPalette="red" onClick={handleDeleteClick}>
              <Icon as={BsTrash} />
            </Button>
          </HStack>
        </HStack>
        {series.description && (
          <Text fontSize="sm" color="fg.muted" mt={1} ml={6}>
            {series.description}
          </Text>
        )}
      </Card.Header>
      <Collapsible.Root open={isExpanded}>
        <Collapsible.Content>
          <Card.Body pt={0}>
            {isLoading ? (
              <Text fontSize="sm" color="fg.muted">
                Loading surveys...
              </Text>
            ) : surveys.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                No surveys in this series.
              </Text>
            ) : (
              <VStack align="stretch" gap={2}>
                {surveys.map((survey, idx) => (
                  <HStack key={survey.id} justify="space-between" fontSize="sm" py={1}>
                    <Text>
                      {(survey as { series_ordinal?: number }).series_ordinal ?? idx + 1}. {survey.title}
                    </Text>
                  </HStack>
                ))}
              </VStack>
            )}
          </Card.Body>
        </Collapsible.Content>
      </Collapsible.Root>
    </Card.Root>
  );
}
