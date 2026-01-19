"use client";

import { Button } from "@/components/ui/button";
import { Icon } from "@chakra-ui/react";
import { FaDownload } from "react-icons/fa";

type StudentEngagement = {
  profile_id: string;
  name: string;
  discussion_karma: number;
  total_posts: number;
  total_replies: number;
  likes_received: number;
  likes_given: number;
};

function sanitizeCell(value: unknown): string {
  // Convert to string
  let str = String(value);
  
  // Escape embedded double-quotes by doubling them
  str = str.replace(/"/g, '""');
  
  // Neutralize leading dangerous characters (=, +, -, @, tab) by prefixing with single quote
  // This prevents formula injection attacks in spreadsheets
  if (/^[=+\-@\t]/.test(str)) {
    str = "'" + str;
  }
  
  return str;
}

function generateCSV(engagement: StudentEngagement[]): string {
  const headers = ["Name", "Karma", "Posts", "Replies", "Likes Received", "Likes Given", "Total Activity"];
  const rows = engagement.map((student) => [
    student.name,
    student.discussion_karma.toString(),
    student.total_posts.toString(),
    student.total_replies.toString(),
    student.likes_received.toString(),
    student.likes_given.toString(),
    (student.total_posts + student.total_replies).toString()
  ]);

  // Sanitize all headers and cells before wrapping with quotes and joining
  const sanitizedHeaders = headers.map(sanitizeCell);
  const sanitizedRows = rows.map((row) => row.map(sanitizeCell));
  
  return [sanitizedHeaders, ...sanitizedRows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
}

export function ExportButton({ engagement, course_id }: { engagement: StudentEngagement[]; course_id: number }) {
  const handleExportCSV = () => {
    const csv = generateCSV(engagement);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `discussion-engagement-${course_id}-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Button onClick={handleExportCSV} variant="outline">
      <Icon as={FaDownload} mr={2} />
      Export CSV
    </Button>
  );
}
