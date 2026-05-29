"use client";

import { useParams } from "next/navigation";
import CurrentRequest from "../currentRequest";
import { useQueueData } from "@/hooks/useQueueData";
import { useEffect, useMemo, useState } from "react";
import { Box, Flex, Spinner, useBreakpointValue } from "@chakra-ui/react";
import { HelpRequestSidebar } from "@/components/help-queue/help-request-sidebar";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";

type LoadState = "pending" | "loaded" | "not_found" | "error";

export default function RequestDetailPage() {
  const { queue_id, course_id, request_id } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isDesktop = useBreakpointValue({ base: false, lg: true }) ?? false;
  const showFullSidebar = isDesktop && sidebarOpen;

  const { queueRequests, userRequests } = useQueueData({
    courseId: Number(course_id),
    queueId: Number(queue_id)
  });

  const requestIdNum = Number(request_id);

  // Find the specific request - could be from user's requests or queue requests
  const request = useMemo(() => {
    return userRequests.find((req) => req.id === requestIdNum) || queueRequests.find((req) => req.id === requestIdNum);
  }, [userRequests, queueRequests, requestIdNum]);

  // The realtime-backed help_requests controller is populated by an
  // initial query plus realtime INSERT broadcasts. If a user lands here
  // via a deep link, a freshly-created request whose realtime broadcast
  // hasn't arrived yet, or a navigation that races the initial query,
  // `request` is undefined and we used to render a flat "Request not
  // found." — which is wrong for the loading case and surfaces as an
  // e2e flake. Distinguish "not yet loaded" from "definitively missing"
  // by issuing a one-shot single-row fetch on mount; only flip to
  // not_found once that fetch has resolved and the row is still absent.
  // The fetch writes through the controller's cache, so the existing
  // useQueueData / useHelpRequests hooks pick it up via their normal
  // notification path.
  const controller = useOfficeHoursController();
  const [loadState, setLoadState] = useState<LoadState>(request ? "loaded" : "pending");
  useEffect(() => {
    if (request) {
      setLoadState("loaded");
      return;
    }
    let cancelled = false;
    setLoadState("pending");
    controller.helpRequests
      .invalidate(requestIdNum)
      .then(() => {
        if (cancelled) return;
        // `invalidate` resolves successfully both when the row was found
        // (and added to cache — `useQueueData` will pick it up via its
        // listener and the effect will re-run with `request` truthy)
        // AND when the row was not found (single() returned data:null
        // without an explicit error, e.g. RLS filtered it out). Only
        // flip to "not_found" if the row really isn't in cache; never
        // flip a transient "not_found" between the cache write and the
        // re-render, which would cause a flash of the error state.
        if (!controller.helpRequests.getById(requestIdNum).data) {
          setLoadState("not_found");
        }
      })
      .catch(() => {
        // Distinct from "not_found": this fires when the REST round-trip
        // itself fails (network blip, auth glitch, 5xx). Rendering
        // "Request not found." in those cases is misleading — the row
        // may very well exist, we just couldn't fetch it.
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [request, controller, requestIdNum]);

  // Calculate position in queue for active requests
  const position = useMemo(() => {
    if (!request || (request.status !== "open" && request.status !== "in_progress")) {
      return 0;
    }
    return queueRequests.findIndex((r) => r.id === request.id) + 1;
  }, [request, queueRequests]);

  if (!request) {
    if (loadState === "not_found") {
      return <div>Request not found.</div>;
    }
    if (loadState === "error") {
      return <div>Unable to load this request right now. Please try again in a moment.</div>;
    }
    return (
      <Flex justify="center" align="center" py={12}>
        <Spinner />
      </Flex>
    );
  }

  return (
    <Flex direction="row" gap={{ base: 3, lg: 6 }} align="stretch">
      <Box
        flex={{ lg: showFullSidebar ? 4 : "unset" }}
        width={{ base: "52px", lg: showFullSidebar ? "auto" : "52px" }}
        minW={0}
      >
        <HelpRequestSidebar
          requestId={Number(request_id)}
          isOpen={showFullSidebar}
          onToggle={() => {
            if (!isDesktop) return;
            setSidebarOpen((v) => !v);
          }}
          queueId={Number(queue_id)}
          isManageMode={false}
        />
      </Box>
      <Box flex={{ lg: 8 }} minW={0}>
        <CurrentRequest request={request} position={position} />
      </Box>
    </Flex>
  );
}
