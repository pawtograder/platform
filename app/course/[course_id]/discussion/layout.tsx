"use client";

import { DiscussionHeader, type DiscussionViewMode } from "@/components/discussion/DiscussionHeader";
import { TopicThreadSidebar } from "@/components/discussion/TopicThreadSidebar";
import { useCourseController, useDiscussionTopics } from "@/hooks/useCourseController";
import { useTableControllerValueById } from "@/lib/TableController";
import { Box, Flex, useBreakpointValue } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    document.title = `${courseController.course.name} - Discussion`;
  }, [courseController.course.name]);

  const handleSearchChange = (q: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (q === "") next.delete("q");
    else next.set("q", q);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isDesktop = useBreakpointValue({ base: false, lg: true }) ?? false;
  const showFullSidebar = isDesktop && sidebarOpen;

  return (
    <Box height="100dvh" overflow="hidden" display="flex" flexDirection="column">
      <DiscussionHeader
        mode={mode}
        onSearchChangeAction={handleSearchChange}
        newPostHref={`${discussionBaseHref}/new`}
        discussionBaseHref={discussionBaseHref}
        currentThread={currentThread}
      />
      <Box flex="1" minH="0" overflow="auto" px={{ base: 3, md: 6 }} py={{ base: 3, md: 6 }}>
        {threadId ? (
          <Flex direction="row" gap={{ base: 3, lg: 6 }} align="stretch">
            <Box
              flex={{ lg: showFullSidebar ? 4 : "unset" }}
              width={{ base: "52px", lg: showFullSidebar ? "auto" : "52px" }}
              minW={0}
            >
              <TopicThreadSidebar
                rootId={threadId}
                isOpen={showFullSidebar}
                onToggle={() => {
                  if (!isDesktop) return;
                  setSidebarOpen((v) => !v);
                }}
              />
            </Box>
            <Box flex={{ lg: 8 }} minW={0}>
              {children}
            </Box>
          </Flex>
        ) : (
          children
        )}
      </Box>
    </Box>
  );
};

export default DiscussionLayout;
