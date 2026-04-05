import { AppNestedRouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { Container } from "@chakra-ui/react";
import { Suspense } from "react";
import { ManageSurveysBody } from "./ManageSurveysBody";
import SurveysHeader from "./SurveysHeader";

type ManageSurveysPageProps = {
  params: Promise<{ course_id: string }>;
};

export default async function ManageSurveysPage({ params }: ManageSurveysPageProps) {
  const { course_id } = await params;

  return (
    <Container py={8} maxW="1200px" my={2}>
      <SurveysHeader courseId={course_id} />
      <Suspense fallback={<AppNestedRouteLoadingSkeleton />}>
        <ManageSurveysBody course_id={course_id} />
      </Suspense>
    </Container>
  );
}
