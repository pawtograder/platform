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
  /** Max height of the scroll region (Chakra token or CSS length). Ignored when `fillHeight` is true. */
  maxHeight?: string;
  estimateRowHeight?: number;
  /**
   * When true, the virtualized list grows with the parent flex column (e.g. browse-by-topic)
   * instead of using a capped max-height and its own tiny scroll viewport.
   */
  fillHeight?: boolean;
};

/**
 * Renders discussion thread rows with windowing when the list is long enough
 * to avoid mounting hundreds of PostRow subtrees at once.
 */
export function VirtualizedPostRowList({
  threadIds,
  courseId,
  maxHeight = "min(70vh, 560px)",
  estimateRowHeight = DEFAULT_ROW_HEIGHT,
  fillHeight = false
}: Props) {
  const listRootRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: threadIds.length,
    getScrollElement: () => listRootRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 6
  });

  if (threadIds.length <= VIRTUALIZE_THRESHOLD) {
    return (
      <Box ref={listRootRef} width="100%" {...(fillHeight ? { flex: 1, minH: 0, minW: 0, overflowY: "auto" } : {})}>
        {threadIds.map((id) => (
          <PostRow key={id} threadId={id} href={`/course/${courseId}/discussion/${id}`} />
        ))}
      </Box>
    );
  }

  return (
    <Box
      ref={listRootRef}
      overflowY="auto"
      {...(fillHeight ? { flex: 1, minH: 0, minW: 0 } : { maxH: maxHeight, minH: "120px" })}
      css={{ contain: "layout paint" }}
    >
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
