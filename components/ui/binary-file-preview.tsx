"use client";

import { SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { Box, Flex, HStack, Icon, Spinner, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { FaDownload, FaFile } from "react-icons/fa";
import DownloadLink from "./download-link";

function isImageMime(mime: string | null): boolean {
  return mime !== null && mime.startsWith("image/");
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BinaryFilePreview({ file }: { file: SubmissionFile }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadFile() {
      if (!file.storage_key) {
        if (isMounted) {
          setError("No storage key for this binary file");
          setLoading(false);
        }
        return;
      }

      const client = createClient();

      const { data: signedUrlData, error: signedUrlError } = await client.storage
        .from("submission-files")
        .createSignedUrl(file.storage_key, 60 * 60 * 24);

      if (!isMounted) return;

      if (signedUrlError) {
        setError(`Failed to create download link: ${signedUrlError.message}`);
        setLoading(false);
        return;
      }

      if (signedUrlData) {
        setSignedUrl(signedUrlData.signedUrl);
      }

      setLoading(false);
    }

    loadFile();

    return () => {
      isMounted = false;
    };
  }, [file.storage_key]);

  return (
    <Box border="1px solid" borderColor="border.emphasized" borderRadius="md" m={2} w="100%">
      <Flex
        w="100%"
        bg="bg.subtle"
        p={2}
        borderBottom="1px solid"
        borderColor="border.emphasized"
        alignItems="center"
        justifyContent="space-between"
      >
        <HStack>
          <Icon as={FaFile} color="fg.muted" />
          <Text fontSize="xs" color="text.subtle">
            {file.name}
          </Text>
          {file.file_size !== null && (
            <Text fontSize="xs" color="fg.muted">
              ({formatFileSize(file.file_size)})
            </Text>
          )}
          {file.mime_type && (
            <Box bg="blue.subtle" px={2} py={0.5} borderRadius="full">
              <Text fontSize="xs" color="blue.fg" fontWeight="medium">
                {file.mime_type}
              </Text>
            </Box>
          )}
        </HStack>
        {signedUrl && (
          <DownloadLink href={signedUrl} filename={file.name}>
            <HStack gap={1}>
              <Icon as={FaDownload} />
              <Text fontSize="xs">Download</Text>
            </HStack>
          </DownloadLink>
        )}
      </Flex>

      <Box p={4}>
        {loading ? (
          <Flex justify="center" align="center" py={8}>
            <Spinner size="md" />
            <Text ml={3} color="fg.muted">
              Loading file...
            </Text>
          </Flex>
        ) : error ? (
          <Box p={4} bg="bg.error" borderRadius="md">
            <Text color="fg.error">{error}</Text>
          </Box>
        ) : isImageMime(file.mime_type) && signedUrl ? (
          <Flex justify="center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={signedUrl}
              alt={file.name}
              loading="lazy"
              style={{
                maxWidth: "100%",
                height: "auto",
                display: "block",
                borderRadius: "0.375rem"
              }}
            />
          </Flex>
        ) : file.mime_type === "application/pdf" && signedUrl ? (
          <Box w="100%" h="600px">
            <iframe
              src={signedUrl}
              style={{ width: "100%", height: "100%", border: "none", borderRadius: "0.375rem" }}
              title={file.name}
            />
          </Box>
        ) : (
          <Flex direction="column" align="center" py={8} gap={3}>
            <Icon as={FaFile} boxSize={12} color="fg.muted" />
            <Text color="fg.muted">No preview available for this file type</Text>
            {signedUrl && (
              <DownloadLink href={signedUrl} filename={file.name}>
                <HStack gap={1}>
                  <Icon as={FaDownload} />
                  <Text>Download {file.name}</Text>
                </HStack>
              </DownloadLink>
            )}
          </Flex>
        )}
      </Box>
    </Box>
  );
}
