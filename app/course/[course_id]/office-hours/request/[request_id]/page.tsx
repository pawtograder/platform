"use client";

import HelpRequestChat from "@/components/help-queue/help-request-chat";
import { Alert } from "@/components/ui/alert";
import { CourseControllerProvider } from "@/hooks/useCourseController";
import { OfficeHoursControllerProvider, useConnectionStatus, useHelpRequest } from "@/hooks/useOfficeHoursRealtime";
import { createClient } from "@/utils/supabase/client";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { Badge, Box, HStack, Icon, Skeleton, Text, VStack } from "@chakra-ui/react";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BsCheckCircle, BsClipboardCheck, BsClipboardCheckFill, BsXCircle } from "react-icons/bs";

/**
 * Component for displaying status-specific visual indicators and information
 * @param status - The current help request status
 * @returns JSX element with status-specific styling and content
 */
const HelpRequestStatusIndicator = ({ status }: { status: HelpRequest["status"] }) => {
  const statusConfig = {
    open: {
      colorPalette: "blue",
      icon: BsClipboardCheck,
      label: "Open",
      description: "Waiting for assistance"
    },
    in_progress: {
      colorPalette: "orange",
      icon: BsClipboardCheckFill,
      label: "In Progress",
      description: "Currently being assisted"
    },
    resolved: {
      colorPalette: "green",
      icon: BsCheckCircle,
      label: "Resolved",
      description: "Help request has been completed"
    },
    closed: {
      colorPalette: "gray",
      icon: BsXCircle,
      label: "Closed",
      description: "Help request has been closed"
    }
  };

  const config = statusConfig[status];

  return (
    <VStack gap={2} align="stretch">
      <HStack justify="space-between" align="center">
        <Badge colorPalette={config.colorPalette} size="lg" variant="solid">
          <HStack gap={1}>
            <Icon as={config.icon} />
            <Text fontWeight="semibold">{config.label}</Text>
          </HStack>
        </Badge>
      </HStack>
      <Text fontSize="sm" color="gray.600">
        {config.description}
      </Text>
      {(status === "resolved" || status === "closed") && (
        <Alert
          status={status === "resolved" ? "success" : "error"}
          title={
            status === "resolved"
              ? "This help request has been resolved. No further actions are available."
              : "This help request has been closed and is no longer active."
          }
        />
      )}
    </VStack>
  );
};

/**
 * Inner component for displaying and managing a help request
 * Shows different visual states based on request status
 * Uses real-time updates for help request data, messages, and staff actions
 */
function StudentHelpRequestPageInner() {
  const { request_id } = useParams();

  // Get help request data and connection status using individual hooks
  const request = useHelpRequest(Number(request_id));
  const { isConnected, connectionStatus, isLoading: realtimeLoading } = useConnectionStatus();

  if (realtimeLoading || !request) {
    return <Skeleton />;
  }
  const isRequestInactive = request.status === "resolved" || request.status === "closed";

  return (
    <Box>
      {/* Connection Status Indicator */}
      {!isConnected && (
        <Alert status="warning" title="Real-time updates disconnected" mb={4}>
          Help request updates may not appear immediately. Connection status: {connectionStatus?.overall}
        </Alert>
      )}

      <Box opacity={isRequestInactive ? 0.7 : 1} transition="opacity 0.2s ease-in-out" m={4}>
        <VStack gap={4} align="stretch" mb={4}>
          <HStack justify="space-between" align="center">
            <HelpRequestStatusIndicator status={request.status} />
          </HStack>
        </VStack>

        <HelpRequestChat request={request} />
      </Box>
    </Box>
  );
}

/**
 * Main page component that handles both regular and popup modes
 * In popup mode, it provides the necessary context providers
 * @returns JSX element for the help request page
 */
export default function StudentHelpRequestPage() {
  const { course_id } = useParams();
  const searchParams = useSearchParams();
  const isPopOut = searchParams.get("popout") === "true";

  const [authData, setAuthData] = useState<{
    profileId: string;
    role: Database["public"]["Enums"]["app_role"];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPopOut) return; // Only fetch auth data in popup mode

    async function fetchAuthData() {
      setLoading(true);
      try {
        const supabase = createClient();
        const {
          data: { user }
        } = await supabase.auth.getUser();

        if (!user) {
          throw new Error("User not authenticated");
        }

        const { data: user_role } = await supabase
          .from("user_roles")
          .select("private_profile_id, role")
          .eq("user_id", user.id)
          .eq("class_id", Number.parseInt(course_id as string))
          .single();

        if (!user_role) {
          throw new Error("User role not found");
        }

        setAuthData({
          profileId: user_role.private_profile_id,
          role: user_role.role
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Authentication failed");
      } finally {
        setLoading(false);
      }
    }

    fetchAuthData();
  }, [isPopOut, course_id]);

  // Regular mode - providers already available from layout
  if (!isPopOut) {
    return <StudentHelpRequestPageInner />;
  }

  // Popup mode - show loading state
  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
        <Skeleton height="200px" width="100%" />
      </Box>
    );
  }

  // Popup mode - show error state
  if (error || !authData) {
    return (
      <Alert status="error" title="Authentication Error">
        {error || "Failed to load user authentication data"}
      </Alert>
    );
  }

  // Popup mode - wrap with providers
  return (
    <CourseControllerProvider
      course_id={Number.parseInt(course_id as string)}
      profile_id={authData.profileId}
      role={authData.role}
    >
      <OfficeHoursControllerProvider
        classId={Number.parseInt(course_id as string)}
        profileId={authData.profileId}
        role={authData.role}
      >
        <StudentHelpRequestPageInner />
      </OfficeHoursControllerProvider>
    </CourseControllerProvider>
  );
}
