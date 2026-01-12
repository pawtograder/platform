"use client";

import { SearchInput } from "@/components/help-queue/search-input";
import { SelectRoot, SelectTrigger, SelectContent, SelectItem, SelectValueText } from "@/components/ui/select";
import { Box, HStack, Icon, createListCollection } from "@chakra-ui/react";
import { BsSortDown, BsSortUp } from "react-icons/bs";
import { useMemo } from "react";

export type RequestStatusFilter = "all" | "open" | "in_progress" | "resolved" | "closed";

export type SortDirection = "oldest-first" | "newest-first";

interface RequestListControlsProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  statusFilter: RequestStatusFilter;
  onStatusFilterChange: (value: RequestStatusFilter) => void;
  sortDirection: SortDirection;
  onSortDirectionChange: (value: SortDirection) => void;
}

export function RequestListControls({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  sortDirection,
  onSortDirectionChange
}: RequestListControlsProps) {
  const statusCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { value: "all", label: "All Statuses" },
          { value: "open", label: "Open" },
          { value: "in_progress", label: "In Progress" },
          { value: "resolved", label: "Resolved" },
          { value: "closed", label: "Closed" }
        ]
      }),
    []
  );

  return (
    <Box px="4" py="3" borderBottomWidth="1px" borderColor="border.muted" bg="bg.panel">
      <HStack gap="3" align="center" wrap="wrap">
        <Box flex="1" minW={{ base: "100%", md: "200px" }}>
          <SearchInput value={searchTerm} onChange={(e) => onSearchChange(e.target.value)} />
        </Box>

        <SelectRoot
          collection={statusCollection}
          value={[statusFilter]}
          onValueChange={(details) => onStatusFilterChange((details.value[0] as RequestStatusFilter) || "all")}
          size="sm"
          width={{ base: "100%", md: "150px" }}
        >
          <SelectTrigger>
            <SelectValueText placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem item={statusCollection.items[0]}>All Statuses</SelectItem>
            <SelectItem item={statusCollection.items[1]}>Open</SelectItem>
            <SelectItem item={statusCollection.items[2]}>In Progress</SelectItem>
            <SelectItem item={statusCollection.items[3]}>Resolved</SelectItem>
            <SelectItem item={statusCollection.items[4]}>Closed</SelectItem>
          </SelectContent>
        </SelectRoot>

        <Box
          as="button"
          onClick={() => {
            onSortDirectionChange(sortDirection === "oldest-first" ? "newest-first" : "oldest-first");
          }}
          px="3"
          py="1.5"
          borderWidth="1px"
          borderColor="border.muted"
          borderRadius="md"
          bg="bg.panel"
          _hover={{ bg: "bg.subtle" }}
          display="flex"
          alignItems="center"
          gap="2"
          fontSize="sm"
          cursor="pointer"
          transition="all 0.2s"
        >
          <Icon as={sortDirection === "oldest-first" ? BsSortDown : BsSortUp} />
          <Box as="span">{sortDirection === "oldest-first" ? "Oldest First" : "Newest First"}</Box>
        </Box>
      </HStack>
    </Box>
  );
}
