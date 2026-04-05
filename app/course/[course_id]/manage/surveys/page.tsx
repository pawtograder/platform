import { Container, Skeleton, Stack } from "@chakra-ui/react";
import { Suspense } from "react";
import { ManageSurveysBody } from "./ManageSurveysBody";
import SurveysHeader from "./SurveysHeader";

function ManageSurveysBodyFallback() {
  return (
    <Stack gap={3} py={2}>
      <Skeleton height="40px" borderRadius="md" />
      <Skeleton height="200px" borderRadius="md" />
    </Stack>
  );
}

type ManageSurveysPageProps = {
  params: Promise<{ course_id: string }>;
};

export default async function ManageSurveysPage({ params }: ManageSurveysPageProps) {
  const { course_id } = await params;

  return (
    <Container py={8} maxW="1200px" my={2}>
      <SurveysHeader courseId={course_id} />
      <Suspense fallback={<ManageSurveysBodyFallback />}>
        <ManageSurveysBody course_id={course_id} />
      </Suspense>
    </Container>
  );
}
