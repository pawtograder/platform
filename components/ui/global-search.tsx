"use client";

import { useAnnouncer } from "@/components/ui/live-announcer";
import { DialogBody, DialogContent, DialogHeader, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { useGlobalSearchIndex } from "@/hooks/useGlobalSearchIndex";
import { filterSearchIndex, type SearchHit } from "@/lib/searchIndex";
import { Box, Heading, HStack, Input, Kbd, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { BsSearch } from "react-icons/bs";

type GlobalSearchContextValue = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
};

const GlobalSearchContext = React.createContext<GlobalSearchContextValue | null>(null);

export function useGlobalSearch() {
  const ctx = React.useContext(GlobalSearchContext);
  if (!ctx) throw new Error("useGlobalSearch must be used inside <GlobalSearchProvider>");
  return ctx;
}

/**
 * App-wide ⌘K / Ctrl+K search palette. Replaces the previous "you must
 * remember which section a thing lives in" navigation. Reuses the
 * existing course controller cache for content; no extra network.
 *
 * The palette opens via:
 *   - the visible "Search" trigger button (course nav, see usage in
 *     dynamicCourseNav.tsx);
 *   - Cmd/Ctrl+K from anywhere in the course;
 *   - `/` or `s` when no per-page search input is currently visible
 *     (handled by useKeyboardShortcuts.tsx fallback).
 */
export function GlobalSearchProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = React.useState(false);
  const open = React.useCallback(() => setIsOpen(true), []);
  const close = React.useCallback(() => setIsOpen(false), []);

  // Mod+K from anywhere.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      if (e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setIsOpen((v) => !v);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const value = React.useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);
  return (
    <GlobalSearchContext.Provider value={value}>
      {children}
      <GlobalSearchDialog isOpen={isOpen} onClose={close} />
    </GlobalSearchContext.Provider>
  );
}

const DEBOUNCE_MS = 120;

function GlobalSearchDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const router = useRouter();
  const announce = useAnnouncer();
  const index = useGlobalSearchIndex();
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const listboxId = React.useId();

  React.useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setDebounced("");
      setFocusedId(null);
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen]);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const groups = React.useMemo(() => filterSearchIndex(index, debounced), [index, debounced]);
  const flatHits = React.useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  // Keep keyboard focus pinned to the first hit when results change.
  React.useEffect(() => {
    if (flatHits.length === 0) {
      setFocusedId(null);
      return;
    }
    setFocusedId((current) => {
      if (current && flatHits.some((h) => h.id === current)) return current;
      return flatHits[0].id;
    });
  }, [flatHits]);

  // Announce result counts politely on each query change.
  const lastAnnouncedRef = React.useRef("");
  React.useEffect(() => {
    if (!isOpen) return;
    if (!debounced) return;
    const total = flatHits.length;
    const msg = total === 0 ? "No matches" : `${total} result${total === 1 ? "" : "s"}`;
    if (msg !== lastAnnouncedRef.current) {
      lastAnnouncedRef.current = msg;
      announce(msg);
    }
  }, [isOpen, debounced, flatHits.length, announce]);

  const navigateTo = React.useCallback(
    (hit: SearchHit) => {
      onClose();
      router.push(hit.url);
    },
    [onClose, router]
  );

  const moveFocus = React.useCallback(
    (delta: number) => {
      if (flatHits.length === 0) return;
      const idx = flatHits.findIndex((h) => h.id === focusedId);
      const next = (idx + delta + flatHits.length) % flatHits.length;
      setFocusedId(flatHits[next].id);
    },
    [flatHits, focusedId]
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flatHits.find((h) => h.id === focusedId);
      if (hit) navigateTo(hit);
    } else if (e.key === "Escape") {
      // Default dialog behavior, but clear query on subsequent opens.
      onClose();
    }
  };

  return (
    <DialogRoot open={isOpen} onOpenChange={({ open }) => (open ? null : onClose())} size="lg" placement="center">
      <DialogContent>
        <VisuallyHidden>
          <DialogHeader>
            <DialogTitle>Search Pawtograder</DialogTitle>
          </DialogHeader>
        </VisuallyHidden>
        <DialogBody p={0}>
          <Box borderBottomWidth="1px" borderColor="border.emphasized" px={3} py={2}>
            <HStack gap={2}>
              <Box color="fg.muted" aria-hidden>
                <BsSearch />
              </Box>
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Search assignments, surveys, posts, pages…"
                aria-label="Search Pawtograder"
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-activedescendant={focusedId ? `gs-option-${focusedId}` : undefined}
                role="combobox"
                aria-expanded={flatHits.length > 0}
                variant="flushed"
                border="none"
                _focusVisible={{ boxShadow: "none", borderColor: "transparent" }}
                size="md"
                flex="1"
              />
            </HStack>
          </Box>
          <Box maxH="60vh" overflowY="auto" id={listboxId} role="listbox" aria-label="Search results">
            {groups.length === 0 ? (
              <Box p={6}>
                <Text fontSize="sm" color="fg.muted" textAlign="center">
                  {debounced ? `No matches for "${debounced}"` : "Start typing to search."}
                </Text>
              </Box>
            ) : (
              <Stack gap={0} p={2}>
                {groups.map((group) => (
                  <Box key={group.kind} role="group" aria-labelledby={`gs-group-${group.kind}`} pb={2}>
                    <Heading
                      as="div"
                      id={`gs-group-${group.kind}`}
                      fontSize="2xs"
                      textTransform="uppercase"
                      letterSpacing="wider"
                      color="fg.muted"
                      px={2}
                      pt={2}
                      pb={1}
                    >
                      {group.label}
                    </Heading>
                    {group.hits.map((hit) => {
                      const isFocused = hit.id === focusedId;
                      return (
                        <Box
                          key={hit.id}
                          id={`gs-option-${hit.id}`}
                          role="option"
                          aria-selected={isFocused}
                          onClick={() => navigateTo(hit)}
                          onMouseEnter={() => setFocusedId(hit.id)}
                          px={2}
                          py={1.5}
                          borderRadius="md"
                          cursor="pointer"
                          bg={isFocused ? "bg.muted" : "transparent"}
                          _hover={{ bg: "bg.muted" }}
                        >
                          <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                            {hit.title}
                            <VisuallyHidden> ({group.label})</VisuallyHidden>
                          </Text>
                          {hit.subtitle && (
                            <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                              {hit.subtitle}
                            </Text>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                ))}
              </Stack>
            )}
          </Box>
          <Box
            borderTopWidth="1px"
            borderColor="border.emphasized"
            px={3}
            py={2}
            display="flex"
            gap={4}
            flexWrap="wrap"
          >
            <HStack gap={1} fontSize="xs" color="fg.muted">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <Text>navigate</Text>
            </HStack>
            <HStack gap={1} fontSize="xs" color="fg.muted">
              <Kbd>Enter</Kbd>
              <Text>open</Text>
            </HStack>
            <HStack gap={1} fontSize="xs" color="fg.muted">
              <Kbd>Esc</Kbd>
              <Text>close</Text>
            </HStack>
          </Box>
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}
