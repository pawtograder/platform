"use client";

import { SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { createClient } from "@/utils/supabase/client";
import { Box, Flex, Heading, HStack, Spinner, Text } from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkGemoji from "remark-gemoji";

// Types for file resolution
type ResolvedImageMap = Record<string, string>;

// Mermaid diagram component - renders code blocks with language "mermaid"
function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "strict",
        });
        const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render mermaid diagram");
        }
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <Box borderWidth="1px" borderColor="border.error" borderRadius="md" p={3} my={2}>
        <Text color="fg.error" fontSize="sm">Mermaid diagram error: {error}</Text>
        <Box as="pre" fontSize="xs" mt={2} p={2} bg="bg.subtle" borderRadius="sm" overflow="auto">
          <code>{code}</code>
        </Box>
      </Box>
    );
  }

  if (!svg) {
    return (
      <Flex justify="center" align="center" py={4}>
        <Spinner size="sm" />
        <Text ml={2} fontSize="sm" color="fg.muted">Rendering diagram...</Text>
      </Flex>
    );
  }

  return (
    <Box
      ref={containerRef}
      my={2}
      display="flex"
      justifyContent="center"
      dangerouslySetInnerHTML={{ __html: svg }}
      css={{
        "& svg": {
          maxWidth: "100%",
          height: "auto",
        },
      }}
    />
  );
}

// Determine the MIME type from a file extension
function getMimeFromExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    tiff: "image/tiff",
    tif: "image/tiff",
  };
  return mimeMap[ext] || "application/octet-stream";
}

// Check if a file is an image
function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif"].includes(ext);
}

// Check if a file is a markdown file
export function isMarkdownFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return ["md", "markdown", "mdown", "mkdn", "mkd"].includes(ext);
}

// Resolve a relative path from the current file's directory
function resolveRelativePath(currentFilePath: string, relativePath: string): string {
  // Get the directory of the current file
  const parts = currentFilePath.split("/");
  parts.pop(); // Remove the file name
  const dir = parts.join("/");

  // Handle relative path
  const segments = (dir ? dir + "/" + relativePath : relativePath).split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "..") {
      resolved.pop();
    } else if (seg !== "." && seg !== "") {
      resolved.push(seg);
    }
  }
  return resolved.join("/");
}

// Fetch binary file content from Supabase Storage and return data URI
async function fetchBinaryFileAsDataUri(storageKey: string, mimeType: string): Promise<string> {
  const client = createClient();
  const { data, error } = await client.storage.from("submission-files").download(storageKey);
  if (error || !data) {
    console.error("Failed to fetch binary file from storage:", error);
    return "";
  }
  const arrayBuffer = await data.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
  );
  return `data:${mimeType};base64,${base64}`;
}

interface MarkdownFilePreviewProps {
  file: SubmissionFile;
  allFiles: SubmissionFile[];
  onNavigateToFile?: (fileId: number) => void;
}

export default function MarkdownFilePreview({ file, allFiles, onNavigateToFile }: MarkdownFilePreviewProps) {
  const [resolvedImages, setResolvedImages] = useState<ResolvedImageMap>({});
  const [loading, setLoading] = useState(true);
  const content = file.contents || "";

  // Build a lookup map of all files by their name/path
  const fileMap = useMemo(() => {
    const map = new Map<string, SubmissionFile>();
    for (const f of allFiles) {
      map.set(f.name, f);
    }
    return map;
  }, [allFiles]);

  // Find all image references in the markdown and pre-resolve them
  useEffect(() => {
    let cancelled = false;

    async function resolveImages() {
      // Match markdown image references: ![alt](path) and HTML img src="path"
      const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["']/g;
      const matches = content.matchAll(imageRegex);
      const imagePaths = new Set<string>();

      for (const match of matches) {
        const imgPath = match[2] || match[3];
        if (imgPath && !imgPath.startsWith("http://") && !imgPath.startsWith("https://") && !imgPath.startsWith("data:")) {
          imagePaths.add(imgPath);
        }
      }

      const resolved: ResolvedImageMap = {};

      for (const imgPath of imagePaths) {
        const resolvedPath = resolveRelativePath(file.name, imgPath);
        const matchingFile = fileMap.get(resolvedPath) || fileMap.get(imgPath);

        if (matchingFile) {
          if (matchingFile.is_binary && matchingFile.storage_key) {
            // Binary file - fetch from Supabase Storage
            const mime = matchingFile.mime_type || getMimeFromExtension(matchingFile.name);
            const dataUri = await fetchBinaryFileAsDataUri(matchingFile.storage_key, mime);
            if (dataUri) {
              resolved[imgPath] = dataUri;
            }
          } else if (!matchingFile.is_binary && matchingFile.contents && isImageFile(matchingFile.name)) {
            // SVG or text-based image stored inline
            const mime = getMimeFromExtension(matchingFile.name);
            if (mime === "image/svg+xml") {
              resolved[imgPath] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(matchingFile.contents)}`;
            }
          }
        }
      }

      if (!cancelled) {
        setResolvedImages(resolved);
        setLoading(false);
      }
    }

    resolveImages();
    return () => {
      cancelled = true;
    };
  }, [content, file.name, fileMap]);

  // Custom components for ReactMarkdown
  const components: Components = useMemo(() => ({
    // Custom image renderer that resolves paths
    img: ({ src, alt, ...props }) => {
      if (src && resolvedImages[src]) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolvedImages[src]}
            alt={alt || ""}
            style={{ maxWidth: "100%", height: "auto" }}
            {...props}
          />
        );
      }
      // For external images, render normally
      if (src && (src.startsWith("http://") || src.startsWith("https://"))) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt || ""} style={{ maxWidth: "100%", height: "auto" }} {...props} />
        );
      }
      // Unresolved local image - show placeholder
      return (
        <Box display="inline-block" borderWidth="1px" borderColor="border.emphasized" borderRadius="md" p={2} my={1}>
          <Text fontSize="sm" color="fg.muted">[Image: {alt || src || "unknown"}]</Text>
        </Box>
      );
    },

    // Custom link renderer that handles internal file navigation
    a: ({ href, children, ...props }) => {
      if (href && !href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("#")) {
        // Relative link - check if it points to another submission file
        const resolvedPath = resolveRelativePath(file.name, href);
        const matchingFile = fileMap.get(resolvedPath) || fileMap.get(href);

        if (matchingFile && onNavigateToFile) {
          return (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onNavigateToFile(matchingFile.id);
              }}
              style={{ color: "var(--chakra-colors-blue-500)", textDecoration: "underline", cursor: "pointer" }}
              {...props}
            >
              {children}
            </a>
          );
        }
      }

      // External link or anchor - render normally
      return (
        <a href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" {...props}>
          {children}
        </a>
      );
    },

    // Custom code block renderer that handles mermaid
    pre: ({ children, ...props }) => {
      // Check if the child is a code element with mermaid language
      if (
        children &&
        typeof children === "object" &&
        "props" in (children as React.ReactElement) &&
        (children as React.ReactElement).props
      ) {
        const childProps = (children as React.ReactElement).props;
        const className = childProps.className || "";
        if (className.includes("language-mermaid")) {
          const code = typeof childProps.children === "string"
            ? childProps.children
            : Array.isArray(childProps.children)
              ? childProps.children.join("")
              : "";
          if (code) {
            return <MermaidDiagram code={code.trim()} />;
          }
        }
      }
      return <pre {...props}>{children}</pre>;
    },

    // Custom table renderer for better styling
    table: ({ children, ...props }) => (
      <Box overflowX="auto" my={2}>
        <Box
          as="table"
          width="100%"
          borderWidth="1px"
          borderColor="border.emphasized"
          borderRadius="md"
          {...props}
          css={{
            borderCollapse: "collapse",
            "& th, & td": {
              border: "1px solid var(--chakra-colors-border-emphasized)",
              padding: "8px 12px",
              textAlign: "left",
            },
            "& th": {
              backgroundColor: "var(--chakra-colors-bg-subtle)",
              fontWeight: "bold",
            },
            "& tr:nth-of-type(even)": {
              backgroundColor: "var(--chakra-colors-bg-subtle)",
            },
          }}
        >
          {children}
        </Box>
      </Box>
    ),

    // Custom checkbox rendering for task lists
    input: ({ type, checked, ...props }) => {
      if (type === "checkbox") {
        return (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            style={{ marginRight: "6px" }}
            {...props}
          />
        );
      }
      return <input type={type} {...props} />;
    },

    // Styled blockquote
    blockquote: ({ children, ...props }) => (
      <Box
        as="blockquote"
        borderLeftWidth="4px"
        borderLeftColor="blue.300"
        pl={4}
        py={1}
        my={2}
        color="fg.muted"
        {...props}
      >
        {children}
      </Box>
    ),

    // Styled headings with anchor links
    h1: ({ children, ...props }) => <Heading as="h1" size="2xl" mt={6} mb={3} {...props}>{children}</Heading>,
    h2: ({ children, ...props }) => <Heading as="h2" size="xl" mt={5} mb={2} borderBottomWidth="1px" borderColor="border.emphasized" pb={1} {...props}>{children}</Heading>,
    h3: ({ children, ...props }) => <Heading as="h3" size="lg" mt={4} mb={2} {...props}>{children}</Heading>,
    h4: ({ children, ...props }) => <Heading as="h4" size="md" mt={3} mb={1} {...props}>{children}</Heading>,
    h5: ({ children, ...props }) => <Heading as="h5" size="sm" mt={2} mb={1} {...props}>{children}</Heading>,
    h6: ({ children, ...props }) => <Heading as="h6" size="xs" mt={2} mb={1} {...props}>{children}</Heading>,

    // Horizontal rule
    hr: ({ ...props }) => <Box as="hr" my={4} borderColor="border.emphasized" {...props} />,
  }), [resolvedImages, file.name, fileMap, onNavigateToFile]);

  if (loading) {
    return (
      <Box p={4}>
        <Flex align="center" gap={2}>
          <Spinner size="sm" />
          <Text color="fg.muted">Loading markdown preview...</Text>
        </Flex>
      </Box>
    );
  }

  return (
    <Box
      border="1px solid"
      borderColor="border.emphasized"
      borderRadius="md"
      m={2}
      w="100%"
    >
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
          <Text fontSize="xs" color="text.subtle">
            {file.name}
          </Text>
          <Box bg="green.subtle" px={2} py={0.5} borderRadius="full">
            <Text fontSize="xs" color="green.fg" fontWeight="medium">
              Preview
            </Text>
          </Box>
        </HStack>
      </Flex>
      <Box p={6} className="markdown-file-preview" css={markdownPreviewStyles}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkGemoji]}
          rehypePlugins={[rehypeKatex, rehypeHighlight]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </Box>
    </Box>
  );
}

// CSS styles for the markdown preview container
const markdownPreviewStyles = {
  "& p": {
    marginBottom: "1em",
    lineHeight: "1.7",
  },
  "& ul, & ol": {
    paddingLeft: "2em",
    marginBottom: "1em",
  },
  "& ul": {
    listStyleType: "disc",
  },
  "& ol": {
    listStyleType: "decimal",
  },
  "& li": {
    display: "list-item",
    marginBottom: "0.25em",
  },
  "& li > ul, & li > ol": {
    marginBottom: 0,
  },
  "& pre": {
    backgroundColor: "var(--chakra-colors-bg-subtle)",
    padding: "1em",
    borderRadius: "0.375rem",
    overflow: "auto",
    marginBottom: "1em",
    border: "1px solid var(--chakra-colors-border-emphasized)",
  },
  "& code": {
    fontFamily: "monospace",
    fontSize: "0.9em",
  },
  "& :not(pre) > code": {
    backgroundColor: "var(--chakra-colors-bg-subtle)",
    padding: "0.2em 0.4em",
    borderRadius: "0.25rem",
    fontSize: "0.85em",
  },
  "& a": {
    color: "var(--chakra-colors-blue-500)",
    textDecoration: "underline",
  },
  "& a:hover": {
    color: "var(--chakra-colors-blue-600)",
  },
  "& img": {
    maxWidth: "100%",
    height: "auto",
    borderRadius: "0.375rem",
  },
  "& .contains-task-list": {
    listStyle: "none",
    paddingLeft: "0.5em",
  },
};
