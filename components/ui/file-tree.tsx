"use client";

import { useSubmissionFileComments } from "@/hooks/useSubmission";
import { SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { Box, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaChevronDown, FaChevronRight, FaFile, FaFolder, FaFolderOpen } from "react-icons/fa";
import { Badge } from "@chakra-ui/react";

export type FileTreeNode = {
  name: string;
  type: "file" | "folder";
  file?: SubmissionFile;
  children: Map<string, FileTreeNode>;
  path: string;
};

/** One row in the flattened, depth-first view of the tree (only entries inside expanded folders). */
export type FlatTreeEntry = {
  type: "file" | "folder";
  name: string;
  path: string;
  fileId?: number;
  level: number;
};

/** Single source of truth for sibling ordering: folders first, then files, both alphabetical. */
function sortNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.type !== b.type) {
    return a.type === "folder" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

type FileTreeSidebarProps = {
  files: SubmissionFile[];
  activeFileId?: number | null;
  onFileSelect: (fileId: number) => void;
  collapsed?: Set<string>;
  onCollapseChange?: (path: string, collapsed: boolean) => void;
  /** Tree path of the row the keyboard cursor is on; rendered with a focus ring (folders included). */
  cursorPath?: string | null;
};

export function buildFileTree(files: SubmissionFile[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "",
    type: "folder",
    children: new Map(),
    path: ""
  };

  for (const file of files) {
    const parts = file.name.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          type: isLast ? "file" : "folder",
          file: isLast ? file : undefined,
          children: new Map(),
          path
        });
      }

      current = current.children.get(part)!;
    }
  }

  return root;
}

/**
 * Depth-first flatten of the tree honoring the collapsed set: a folder's children are emitted only
 * when the folder is expanded. Mirrors the on-screen order so keyboard navigation (FilesView) and the
 * rendered tree agree on which row is "next"/"previous".
 */
export function flattenVisibleTree(root: FileTreeNode, collapsed: Set<string>): FlatTreeEntry[] {
  const out: FlatTreeEntry[] = [];

  const walk = (node: FileTreeNode, level: number) => {
    for (const child of Array.from(node.children.values()).sort(sortNodes)) {
      out.push({
        type: child.type,
        name: child.name,
        path: child.path,
        fileId: child.file?.id,
        level
      });
      if (child.type === "folder" && child.children.size > 0 && !collapsed.has(child.path)) {
        walk(child, level + 1);
      }
    }
  };

  walk(root, 0);
  return out;
}

/** Folder paths (prefixes) that must be expanded for `fileName` to be visible. */
export function ancestorFolderPaths(fileName: string): string[] {
  const parts = fileName.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(0, i + 1).join("/"));
  }
  return out;
}

function FileTreeItem({
  node,
  level,
  activeFileId,
  onFileSelect,
  collapsed,
  onCollapseChange,
  commentCounts,
  cursorPath
}: {
  node: FileTreeNode;
  level: number;
  activeFileId?: number | null;
  onFileSelect: (fileId: number) => void;
  collapsed: Set<string>;
  onCollapseChange: (path: string, collapsed: boolean) => void;
  commentCounts: Map<number, number>;
  cursorPath?: string | null;
}) {
  const isCollapsed = collapsed.has(node.path);
  const hasChildren = node.children.size > 0;
  const isFile = node.type === "file";
  const isActive = node.file?.id === activeFileId;
  const isCursor = cursorPath != null && node.path === cursorPath;
  const commentCount = node.file ? (commentCounts.get(node.file.id) ?? 0) : 0;
  const rowRef = useRef<HTMLDivElement>(null);

  // Keep the active/cursor row visible as the selection moves (mouse, URL, or keyboard navigation).
  useEffect(() => {
    if (isActive || isCursor) {
      rowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isActive, isCursor]);

  const handleClick = () => {
    if (isFile && node.file) {
      onFileSelect(node.file.id);
    } else if (hasChildren) {
      onCollapseChange(node.path, !isCollapsed);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFile && node.file) {
      onFileSelect(node.file.id);
    } else if (hasChildren) {
      onCollapseChange(node.path, !isCollapsed);
    }
  };

  return (
    <VStack align="stretch" gap={0}>
      <HStack
        ref={rowRef}
        pl={`${level * 16}px`}
        pr={2}
        py={1}
        cursor="pointer"
        bg={isActive ? "bg.info" : "transparent"}
        _hover={{ bg: "bg.muted" }}
        outline={isCursor ? "2px solid" : undefined}
        outlineColor={isCursor ? "fg.info" : undefined}
        outlineOffset="-2px"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        gap={1}
        minH="24px"
        data-active={isActive ? "true" : undefined}
        data-cursor={isCursor ? "true" : undefined}
        aria-current={isActive ? "true" : undefined}
        data-file-id={node.file?.id}
        data-tree-path={node.path}
      >
        {hasChildren && (
          <Icon as={isCollapsed ? FaChevronRight : FaChevronDown} boxSize={3} color="fg.muted" flexShrink={0} />
        )}
        {!hasChildren && <Box w="12px" />}
        <Icon
          as={isFile ? FaFile : isCollapsed ? FaFolder : FaFolderOpen}
          boxSize={4}
          color={isFile ? "fg.muted" : "fg.info"}
          flexShrink={0}
        />
        <Text
          fontSize="sm"
          fontWeight={isActive ? "semibold" : "normal"}
          color={isActive ? "fg.info" : "fg.default"}
          flex={1}
          lineClamp={1}
        >
          {node.name}
        </Text>
        {commentCount > 0 && (
          <Badge colorPalette="blue" size="sm" flexShrink={0}>
            {commentCount}
          </Badge>
        )}
      </HStack>
      {hasChildren && !isCollapsed && (
        <VStack align="stretch" gap={0}>
          {Array.from(node.children.values())
            .sort(sortNodes)
            .map((child) => (
              <FileTreeItem
                key={child.path}
                node={child}
                level={level + 1}
                activeFileId={activeFileId}
                onFileSelect={onFileSelect}
                collapsed={collapsed}
                onCollapseChange={onCollapseChange}
                commentCounts={commentCounts}
                cursorPath={cursorPath}
              />
            ))}
        </VStack>
      )}
    </VStack>
  );
}

export function FileTreeSidebar({
  files,
  activeFileId,
  onFileSelect,
  collapsed: externalCollapsed,
  onCollapseChange: externalOnCollapseChange,
  cursorPath
}: FileTreeSidebarProps) {
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set());
  const comments = useSubmissionFileComments({});

  const commentCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const comment of comments) {
      const current = counts.get(comment.submission_file_id) ?? 0;
      counts.set(comment.submission_file_id, current + 1);
    }
    return counts;
  }, [comments]);

  const collapsed = externalCollapsed ?? internalCollapsed;
  const onCollapseChange =
    externalOnCollapseChange ??
    ((path: string, isCollapsed: boolean) => {
      setInternalCollapsed((prev) => {
        const next = new Set(prev);
        if (isCollapsed) {
          next.add(path);
        } else {
          next.delete(path);
        }
        return next;
      });
    });

  const tree = useMemo(() => buildFileTree(files), [files]);

  return (
    <Box
      w="100%"
      h="100%"
      overflowY="auto"
      borderRight="1px solid"
      borderColor="border.emphasized"
      bg="bg.subtle"
      css={{
        "&::-webkit-scrollbar": {
          width: "8px"
        },
        "&::-webkit-scrollbar-track": {
          background: "transparent"
        },
        "&::-webkit-scrollbar-thumb": {
          background: "var(--chakra-colors-border-emphasized)",
          borderRadius: "4px"
        },
        "&::-webkit-scrollbar-thumb:hover": {
          background: "var(--chakra-colors-fg-muted)"
        }
      }}
    >
      <VStack align="stretch" gap={0} py={1}>
        {Array.from(tree.children.values())
          .sort(sortNodes)
          .map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              level={0}
              activeFileId={activeFileId}
              onFileSelect={onFileSelect}
              collapsed={collapsed}
              onCollapseChange={onCollapseChange}
              commentCounts={commentCounts}
              cursorPath={cursorPath}
            />
          ))}
      </VStack>
    </Box>
  );
}
