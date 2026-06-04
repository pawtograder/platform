"use client";

import { toaster } from "@/components/ui/toaster";
import { PendingUploadFile, uploadNoRepoSubmission } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Box, Button, Flex, HStack, Icon, IconButton, Text, VStack } from "@chakra-ui/react";
import { useCallback, useRef, useState } from "react";
import { FaTimes, FaUpload } from "react-icons/fa";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Drag-and-drop / click-to-upload control for assignments with
 * `repo_mode='none'`. Each upload creates a new active submission with the
 * selected files attached. Calls `onUploaded(submissionId)` after a successful
 * submission so the caller can refresh the submission history.
 *
 * Omit `target` for the student self-submit flow. Pass `target` (a profile or
 * group) for the instructor/grader "submit on behalf of a student" flow.
 */
export default function UploadSubmission({
  assignmentId,
  target,
  helperText = "Your instructor accepts file uploads for this assignment instead of a Git repository.",
  buttonLabel = "Upload submission",
  onUploaded
}: {
  assignmentId: number;
  target?: { profile_id?: string; assignment_group_id?: number };
  helperText?: string;
  buttonLabel?: string;
  onUploaded?: (submissionId: number) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const next = Array.from(incoming);
    setFiles((prev) => {
      // De-dupe by name+size so re-selecting the same file doesn't double it.
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...next.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleUpload = useCallback(async () => {
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      const supabase = createClient();
      const pending: PendingUploadFile[] = files.map((f) => ({
        name: f.name,
        file: f,
        size: f.size,
        mimeType: f.type || null
      }));
      const submissionId = await uploadNoRepoSubmission(
        { assignment_id: assignmentId, files: pending, target },
        supabase
      );
      toaster.success({
        title: "Submission uploaded",
        description: `Uploaded ${files.length} file${files.length === 1 ? "" : "s"}.`
      });
      setFiles([]);
      onUploaded?.(submissionId);
    } catch (e) {
      toaster.error({
        title: "Upload failed",
        description: e instanceof Error ? e.message : "Could not upload your files. Please try again."
      });
    } finally {
      setIsUploading(false);
    }
  }, [files, assignmentId, onUploaded]);

  return (
    <Box m={4} maxW="4xl">
      <Box
        role="button"
        tabIndex={0}
        aria-label="Upload submission files"
        borderWidth={2}
        borderStyle="dashed"
        borderColor={isDragging ? "border.info" : "border.emphasized"}
        bg={isDragging ? "bg.info" : "bg.subtle"}
        borderRadius="md"
        p={8}
        textAlign="center"
        cursor="pointer"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <VStack gap={1}>
          <Icon as={FaUpload} boxSize={6} color="fg.muted" />
          <Text fontWeight="medium">Drag and drop files here, or click to choose</Text>
          <Text fontSize="sm" color="fg.muted">
            {helperText}
          </Text>
        </VStack>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          data-testid="upload-submission-input"
          onChange={(e) => {
            addFiles(e.target.files);
            // Reset so selecting the same file again re-fires onChange.
            e.target.value = "";
          }}
        />
      </Box>

      {files.length > 0 && (
        <VStack align="stretch" gap={1} mt={3}>
          {files.map((f, idx) => (
            <Flex
              key={`${f.name}:${f.size}:${idx}`}
              justify="space-between"
              align="center"
              borderWidth={1}
              borderColor="border.muted"
              borderRadius="sm"
              px={3}
              py={2}
            >
              <HStack gap={2} minW={0}>
                <Text truncate>{f.name}</Text>
                <Text fontSize="sm" color="fg.muted" flexShrink={0}>
                  {formatBytes(f.size)}
                </Text>
              </HStack>
              <IconButton
                aria-label={`Remove ${f.name}`}
                size="xs"
                variant="ghost"
                disabled={isUploading}
                onClick={() => removeFile(idx)}
              >
                <Icon as={FaTimes} />
              </IconButton>
            </Flex>
          ))}
        </VStack>
      )}

      <HStack mt={3}>
        <Button colorPalette="green" loading={isUploading} disabled={files.length === 0} onClick={handleUpload}>
          <Icon as={FaUpload} /> {buttonLabel}
        </Button>
      </HStack>
    </Box>
  );
}
