"use client";
import { Button } from "@/components/ui/button";
import { useHelpRequestWatchStatus } from "@/hooks/useHelpRequestWatches";
import { FaEye, FaEyeSlash } from "react-icons/fa";

type HelpRequestWatchButtonProps = {
  helpRequestId: number;
  variant?: "ghost" | "outline" | "solid" | "subtle" | "surface" | "plain";
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
};

/**
 * Button component for toggling help request watch status.
 * Allows users to watch/unwatch help requests to control notification delivery.
 * Shows "Watch" with eye icon when not watching, "Unwatch" with eye-slash when watching.
 *
 * @param helpRequestId - The ID of the help request to watch/unwatch
 * @param variant - Button variant (default: "ghost")
 * @param size - Button size (default: "sm")
 */
export function HelpRequestWatchButton({ helpRequestId, variant = "ghost", size = "sm" }: HelpRequestWatchButtonProps) {
  const { status, setHelpRequestWatchStatus } = useHelpRequestWatchStatus(helpRequestId);

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => {
        setHelpRequestWatchStatus(!status);
      }}
      className="gap-2"
    >
      {status ? "Unwatch" : "Watch"}
      {status ? <FaEyeSlash /> : <FaEye />}
    </Button>
  );
}
