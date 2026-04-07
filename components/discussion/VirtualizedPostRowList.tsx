"use client";

import { PostRow } from "@/components/discussion/PostRow";
import { Box } from "@chakra-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";

const DEFAULT_ROW_HEIGHT = 92;
const VIRTUALIZE_THRESHOLD = 24;

type Props = {
  threadIds: number[];
  courseId: number;
  /** Max height of the scroll region (Chakra token or CSS length). */
  maxHeight?: string;
  estimateRowHeight?: number;
};

/**
 * Renders discussion thread rows with windowing when the list is long enough
 * to avoid mounting hundreds of PostRow subtrees at once.
 */
export function VirtualizedPostRowList({
  threadIds,
  courseId,
  maxHeight = "min(70vh, 560px)",
  estimateRowHeight = DEFAULT_ROW_HEIGHT
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: threadIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 6
  });

  if (threadIds.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <>
        {threadIds.map((id) => (
          <PostRow key={id} threadId={id} href={`/course/${courseId}/discussion/${id}`} />
        ))}
      </>
    );
  }

  return (
    <Box ref={parentRef} overflowY="auto" maxH={maxHeight} minH="120px" css={{ contain: "strict" }}>
      <Box height={`${rowVirtualizer.getTotalSize()}px`} position="relative" width="100%">
        {rowVirtualizer.getVirtualItems().map((vi) => (
          <Box
            key={vi.key}
            ref={rowVirtualizer.measureElement}
            data-index={vi.index}
            position="absolute"
            top={0}
            left={0}
            width="100%"
            transform={`translateY(${vi.start}px)`}
          >
            <PostRow threadId={threadIds[vi.index]} href={`/course/${courseId}/discussion/${threadIds[vi.index]}`} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}
