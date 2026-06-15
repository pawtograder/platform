"use client";

import { SubmissionArtifact } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Flex, Heading, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";

type NormRect = { x: number; y: number; width: number; height: number };
type ExamPageRef = { page_number: number; storage_key: string; width: number; height: number };
type ExamQuestionResult = {
  exam_question_id: number;
  page_number: number;
  region: NormRect;
  ocr_text: string;
  structured_value: unknown;
};
type ExamArtifactData = { format: "exam_v1"; pages: ExamPageRef[]; questions: ExamQuestionResult[] };

/** CSS sprite-style crop: show only `region` of the page image. */
function RegionCrop({ url, region, height = 120 }: { url: string; region: NormRect; height?: number }) {
  // background-position as a percentage relative to the un-shown remainder
  const posX = region.width < 1 ? (region.x / (1 - region.width)) * 100 : 0;
  const posY = region.height < 1 ? (region.y / (1 - region.height)) * 100 : 0;
  const aspect = region.height > 0 ? region.width / region.height : 4;
  return (
    <Box
      style={{
        width: `${Math.round(height * aspect)}px`,
        height: `${height}px`,
        backgroundImage: `url("${url}")`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${region.width > 0 ? 100 / region.width : 100}% ${region.height > 0 ? 100 / region.height : 100}%`,
        backgroundPosition: `${posX}% ${posY}%`,
        borderRadius: "4px"
      }}
      borderWidth="1px"
      borderColor="border.emphasized"
    />
  );
}

export default function ExamSubmissionRenderer({ artifact }: { artifact: SubmissionArtifact }) {
  const data = artifact.data as unknown as ExamArtifactData;
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [showOriginal, setShowOriginal] = useState<Record<number, boolean>>({});

  const pageByNumber = useMemo(() => {
    const m: Record<number, ExamPageRef> = {};
    for (const p of data?.pages ?? []) m[p.page_number] = p;
    return m;
  }, [data]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const client = createClient();
      const pages = data?.pages ?? [];
      // Sign all page URLs in parallel (was serial — slow first paint for multi-page exams).
      const signed = await Promise.all(
        pages.map((p) =>
          client.storage
            .from("submission-files")
            .createSignedUrl(p.storage_key, 60 * 60 * 24)
            .then(({ data: s }) => [p.page_number, s?.signedUrl] as const)
        )
      );
      const next: Record<number, string> = {};
      for (const [pageNumber, url] of signed) {
        if (url) next[pageNumber] = url;
      }
      if (mounted) {
        setUrls(next);
        setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, [data]);

  if (!data || data.format !== "exam_v1") {
    return <Text color="fg.muted">Unsupported exam artifact.</Text>;
  }
  if (loading) return <Spinner />;

  return (
    <VStack align="stretch" gap={4}>
      {(data.questions ?? []).map((q, idx) => {
        const url = urls[q.page_number];
        return (
          <Box
            key={`${q.exam_question_id}-${idx}`}
            borderWidth="1px"
            borderColor="border.muted"
            borderRadius="md"
            p={3}
          >
            <HStack justify="space-between" mb={2}>
              <Heading size="sm">Question {q.exam_question_id}</Heading>
              <Button size="xs" variant="outline" onClick={() => setShowOriginal((s) => ({ ...s, [idx]: !s[idx] }))}>
                {showOriginal[idx] ? "Hide original page" : "View original page"}
              </Button>
            </HStack>
            <Flex gap={4} wrap="wrap" align="flex-start">
              {url ? (
                <RegionCrop url={url} region={q.region} />
              ) : (
                <Text fontSize="xs" color="fg.muted">
                  (page image unavailable)
                </Text>
              )}
              <Box flex="1" minW="200px">
                <Text fontSize="xs" color="fg.muted" mb={1}>
                  OCR text
                </Text>
                <Box bg="bg.subtle" borderRadius="md" p={2} fontSize="sm" whiteSpace="pre-wrap">
                  {q.ocr_text || <Text color="fg.muted">(no text detected)</Text>}
                </Box>
                {q.structured_value !== undefined &&
                  q.structured_value !== null &&
                  q.structured_value !== q.ocr_text && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Interpreted:{" "}
                      {String(
                        typeof q.structured_value === "object" ? JSON.stringify(q.structured_value) : q.structured_value
                      )}
                    </Text>
                  )}
              </Box>
            </Flex>
            {showOriginal[idx] && url && (
              <Box mt={3}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Original page ${q.page_number}`}
                  loading="lazy"
                  style={{ maxWidth: "100%", height: "auto", borderRadius: "4px" }}
                />
              </Box>
            )}
          </Box>
        );
      })}
      {(data.questions ?? []).length === 0 && <Text color="fg.muted">No questions were extracted for this exam.</Text>}
      {/* Quick access to all original pages */}
      <Box>
        <Heading size="xs" mb={2}>
          All scanned pages
        </Heading>
        <Flex gap={2} wrap="wrap">
          {(data.pages ?? []).map((p) =>
            urls[p.page_number] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={p.page_number}
                src={urls[p.page_number]}
                alt={`Page ${p.page_number}`}
                loading="lazy"
                style={{
                  maxHeight: "160px",
                  borderRadius: "4px",
                  border: "1px solid var(--chakra-colors-border-muted)"
                }}
              />
            ) : null
          )}
          {Object.keys(pageByNumber).length === 0 && <Text color="fg.muted">No pages.</Text>}
        </Flex>
      </Box>
    </VStack>
  );
}
