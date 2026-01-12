"use client";

import { useSubmission, useSubmissionFileComments } from "@/hooks/useSubmission";
import { SubmissionFile } from "@/utils/supabase/DatabaseTypes";
import { Box, Button, Flex, HStack, Icon, Text, VStack } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { FaChevronDown, FaChevronRight, FaFile, FaFolder, FaFolderOpen } from "react-icons/fa";
import { Badge } from "@chakra-ui/react";

type FileTreeNode = {
  name: string;
  type: "file" | "folder";
  file?: SubmissionFile;
  children: Map<string, FileTreeNode>;
  path: string;
};

type FileTreeSidebarProps = {
  files: SubmissionFile[];
  activeFileId?: number | null;
  onFileSelect: (fileId: number) => void;
  collapsed?: Set<string>;
  onCollapseChange?: (path: string, collapsed: boolean) => void;
};

function buildFileTree(files: SubmissionFile[]): FileTreeNode {
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

function FileTreeItem({
  node,
  level,
  activeFileId,
  onFileSelect,
  collapsed,
  onCollapseChange,
  commentCounts
}: {
  node: FileTreeNode;
  level: number;
  activeFileId?: number | null;
  onFileSelect: (fileId: number) => void;
  collapsed: Set<string>;
  onCollapseChange: (path: string, collapsed: boolean) => void;
  commentCounts: Map<number, number>;
}) {
  const isCollapsed = collapsed.has(node.path);
  const hasChildren = node.children.size > 0;
  const isFile = node.type === "file";
  const isActive = node.file?.id === activeFileId;
  const commentCount = node.file ? commentCounts.get(node.file.id) ?? 0 : 0;

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
        pl={`${level * 16}px`}
        pr={2}
        py={1}
        cursor="pointer"
        bg={isActive ? "bg.info" : "transparent"}
        _hover={{ bg: "bg.muted" }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        gap={1}
        minH="24px"
      >
        {hasChildren && (
          <Icon
            as={isCollapsed ? FaChevronRight : FaChevronDown}
            boxSize={3}
            color="fg.muted"
            flexShrink={0}
          />
        )}
        {!hasChildren && <Box w="12px" />}
        <Icon
          as={
            isFile
              ? FaFile
              : isCollapsed
                ? FaFolder
                : FaFolderOpen
          }
          boxSize={4}
          color={isFile ? "fg.muted" : "fg.info"}
          flexShrink={0}
        />
        <Text
          fontSize="sm"
          fontWeight={isActive ? "semibold" : "normal"}
          color={isActive ? "fg.info" : "fg.default"}
          flex={1}
          noOfLines={1}
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
            .sort((a, b) => {
              // Folders first, then files, both alphabetically
              if (a.type !== b.type) {
                return a.type === "folder" ? -1 : 1;
              }
              return a.name.localeCompare(b.name);
            })
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
  onCollapseChange: externalOnCollapseChange
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
          .sort((a, b) => {
            if (a.type !== b.type) {
              return a.type === "folder" ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          })
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
            />
          ))}
      </VStack>
    </Box>
  );
}
