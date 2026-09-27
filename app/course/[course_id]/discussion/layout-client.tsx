"use client";

import { DiscussionHeader, type DiscussionViewMode } from "@/components/discussion/DiscussionHeader";
import { TopicThreadSidebar } from "@/components/discussion/TopicThreadSidebar";
import { useCourseController, useDiscussionTopics } from "@/hooks/useCourseController";
import { useTableControllerValueById } from "@/lib/TableController";
import { Box, Flex, useBreakpointValue } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";

const DiscussionLayout = ({ children }: Readonly<{ children: React.ReactNode }>) => {
  const { course_id, root_id } = useParams();
  const courseController = useCourseController();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const discussionBaseHref = `/course/${course_id}/discussion`;

  // Get the current thread if we're viewing a single discussion
  const threadId = root_id ? Number.parseInt(root_id as string) : null;
  const currentThreadData = useTableControllerValueById(courseController.discussionThreadTeasers, threadId ?? -1);
  const topics = useDiscussionTopics();

  const currentThread = useMemo(() => {
    if (!threadId || !currentThreadData || currentThreadData.ordinal === null) return undefined;
    const topic = topics?.find((t) => t.id === currentThreadData.topic_id);
    return {
      number: currentThreadData.ordinal,
      title: currentThreadData.subject,
      topic: topic ? { id: topic.id, name: topic.topic } : undefined
    };
  }, [threadId, currentThreadData, topics]);

  const mode = useMemo<DiscussionViewMode>(() => {
    const v = searchParams.get("view");
    return v === "browse" ? "browse" : "feed";
  }, [searchParams]);

  const handleSearchChange = (q: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (q === "") next.delete("q");
    else next.set("q", q);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  // Sidebar defaults open on desktop, collapsed on small screens; toggleable everywhere so
  // keyboard/touch users are not locked out of the thread list at narrow widths.
  const [sidebarOpen, setSidebarOpen] = useState<boolean | null>(null);
  const isDesktop = useBreakpointValue({ base: false, lg: true }) ?? false;
  const showFullSidebar = sidebarOpen ?? isDesktop;

  return (
    // WCAG 1.4.10 (Reflow): the fixed 100dvh/overflow-hidden app shell only applies from md up.
    // At narrow widths (== 400% zoom on a 1280px window) the page is a normal scrolling document
    // so no content is clipped behind an overflow-hidden container.
    <Box
      as="section"
      aria-label="Discussion"
      height={{ base: "auto", md: "100dvh" }}
      minH={{ base: "100dvh", md: "auto" }}
      overflow={{ base: "visible", md: "hidden" }}
      display="flex"
      flexDirection="column"
    >
      <DiscussionHeader
        mode={mode}
        onSearchChangeAction={handleSearchChange}
        newPostHref={`${discussionBaseHref}/new`}
        discussionBaseHref={discussionBaseHref}
        currentThread={currentThread}
      />
      <Box
        flex="1"
        minH={0}
        overflow={{ base: "visible", md: "auto" }}
        px={{ base: 3, md: 6 }}
        pt={{ base: 3, md: 6 }}
        pb="80px"
        display="flex"
        flexDirection="column"
      >
        {threadId ? (
          <Flex direction={{ base: "column", lg: "row" }} gap={{ base: 3, lg: 6 }} align="stretch" flex="1" minH={0}>
            <Box
              flex={{ lg: showFullSidebar ? 4 : "unset" }}
              width={{ base: "100%", lg: showFullSidebar ? "auto" : "52px" }}
              minW={0}
            >
              <TopicThreadSidebar
                rootId={threadId}
                isOpen={showFullSidebar}
                onToggle={() => {
                  setSidebarOpen((v) => !(v ?? isDesktop));
                }}
              />
            </Box>
            <Box flex={{ base: 1, lg: 8 }} minW={0} minH={0} display="flex" flexDirection="column">
              {children}
            </Box>
          </Flex>
        ) : (
          <Box flex="1" minH={0} display="flex" flexDirection="column">
            {children}
          </Box>
        )}
      </Box>
    </Box>
  );
};

export default DiscussionLayout;
