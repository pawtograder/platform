"use client";

import { Container, Heading, HStack, Button } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import SurveysHeader from "../SurveysHeader";
import SurveySeriesList from "@/components/survey/SurveySeriesList";
import SeriesManagementModal from "@/components/survey/SeriesManagementModal";
import type { SurveySeriesRow } from "@/types/survey-analytics";
import { useState } from "react";

export default function SurveySeriesPage() {
  const { course_id } = useParams();
  const courseId = course_id as string;
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSeries, setEditingSeries] = useState<SurveySeriesRow | null>(null);

  const handleCreate = () => {
    setEditingSeries(null);
    setModalOpen(true);
  };

  const handleEdit = (series: SurveySeriesRow) => {
    setEditingSeries(series);
    setModalOpen(true);
  };

  const handleModalSuccess = () => {
    setModalOpen(false);
    setEditingSeries(null);
  };

  const handleModalClose = () => {
    setModalOpen(false);
    setEditingSeries(null);
  };

  return (
    <Container py={8} maxW="1200px" my={2}>
      <SurveysHeader courseId={courseId} />
      <HStack justify="space-between" mb={6}>
        <Heading size="lg" color="fg.default">
          Survey Series
        </Heading>
        <Button size="sm" colorPalette="blue" onClick={handleCreate}>
          Create Series
        </Button>
      </HStack>
      <SurveySeriesList classId={Number(courseId)} onEditSeries={handleEdit} onDeleteSeries={() => {}} />
      <SeriesManagementModal
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={handleModalSuccess}
        classId={Number(courseId)}
        existingSeries={editingSeries}
      />
    </Container>
  );
}
