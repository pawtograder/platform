"use client";

import { useAnnouncer } from "@/components/ui/live-announcer";
import { DialogBody, DialogContent, DialogHeader, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { useGlobalSearchIndex } from "@/hooks/useGlobalSearchIndex";
import { OPEN_SHORTCUTS_HELP_EVENT } from "@/lib/clientEvents";
import { filterSearchIndex, type SearchHit } from "@/lib/searchIndex";
import { Box, Button, Heading, HStack, Input, Kbd, Spacer, Stack, Text, VisuallyHidden } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { BsChevronLeft, BsChevronRight, BsSearch } from "react-icons/bs";
import { FiCommand } from "react-icons/fi";

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

  // Mod+K from anywhere — but skip while the user is typing in a form
  // field or contenteditable region so we don't clobber native editor
  // shortcuts (e.g. Cmd+K in Monaco, browser address-bar focus).
  React.useEffect(() => {
    function isEditableTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      return !!target.closest('input, textarea, select, [role="textbox"], [contenteditable="true"]');
    }
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.altKey || e.shiftKey) return;
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      if (e.key.toLowerCase() !== "k") return;
      if (isEditableTarget(e.target)) return;
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
  // When the user activates a hit with children (e.g. an instructor picks
  // an assignment), we drill into a nested chooser of its sub-pages instead
  // of navigating. Backspace on an empty query or Escape pops back out.
  const [drilldown, setDrilldown] = React.useState<SearchHit | null>(null);

  React.useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setDebounced("");
      setFocusedId(null);
      setDrilldown(null);
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Reset the query when entering/exiting a drill-down so the filter input
  // doesn't carry over the parent's search term to a child list of ~12 items.
  React.useEffect(() => {
    setQuery("");
    setDebounced("");
    setFocusedId(null);
    inputRef.current?.focus();
  }, [drilldown]);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const activeIndex = React.useMemo<SearchHit[]>(
    () => (drilldown?.children ? drilldown.children : index),
    [drilldown, index]
  );
  const groups = React.useMemo(() => {
    // In drill-down mode with an empty query, show every child rather than
    // the default "launcher view" (which only surfaces page/setting kinds
    // and would hide an assignment's manage sub-pages).
    if (drilldown && !debounced) {
      return [{ kind: "page" as const, label: drilldown.title, hits: drilldown.children ?? [] }];
    }
    return filterSearchIndex(activeIndex, debounced);
  }, [activeIndex, debounced, drilldown]);
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

  const activateHit = React.useCallback(
    (hit: SearchHit) => {
      // Hits with children open a nested chooser instead of navigating.
      // We only do this at the top level; children themselves never nest.
      if (!drilldown && hit.children && hit.children.length > 0) {
        setDrilldown(hit);
        return;
      }
      navigateTo(hit);
    },
    [drilldown, navigateTo]
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
      if (hit) activateHit(hit);
    } else if (e.key === "Backspace" && drilldown && query.length === 0) {
      // Empty-query backspace pops out of drill-down rather than deleting
      // nothing; mirrors the gesture used by Linear/Raycast palettes.
      e.preventDefault();
      setDrilldown(null);
    } else if (e.key === "Escape") {
      if (drilldown) {
        e.preventDefault();
        setDrilldown(null);
        return;
      }
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
              {drilldown && (
                <HStack
                  gap={1}
                  px={2}
                  py={1}
                  bg="bg.muted"
                  borderRadius="md"
                  fontSize="xs"
                  fontWeight="medium"
                  aria-label={`Browsing ${drilldown.title}`}
                  cursor="pointer"
                  onClick={() => setDrilldown(null)}
                  title="Back (Esc)"
                >
                  <BsChevronLeft />
                  <Text lineClamp={1} maxW="40">
                    {drilldown.title}
                  </Text>
                </HStack>
              )}
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={
                  drilldown ? `Jump to a page in ${drilldown.title}…` : "Search assignments, surveys, posts, pages…"
                }
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
                      const hasChildren = !drilldown && !!hit.children && hit.children.length > 0;
                      return (
                        <Box
                          key={hit.id}
                          id={`gs-option-${hit.id}`}
                          role="option"
                          aria-selected={isFocused}
                          aria-haspopup={hasChildren ? "listbox" : undefined}
                          onClick={() => activateHit(hit)}
                          onMouseEnter={() => setFocusedId(hit.id)}
                          px={2}
                          py={1.5}
                          borderRadius="md"
                          cursor="pointer"
                          bg={isFocused ? "bg.muted" : "transparent"}
                          _hover={{ bg: "bg.muted" }}
                        >
                          <HStack gap={2} justify="space-between" align="center">
                            <Box minW={0} flex="1">
                              <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                                {hit.title}
                                <VisuallyHidden> ({group.label})</VisuallyHidden>
                                {hasChildren && <VisuallyHidden> — opens sub-pages</VisuallyHidden>}
                              </Text>
                              {hit.subtitle && (
                                <Text fontSize="xs" color="fg.muted" lineClamp={1}>
                                  {hit.subtitle}
                                </Text>
                              )}
                            </Box>
                            {hasChildren && (
                              <Box color="fg.muted" aria-hidden flexShrink={0}>
                                <BsChevronRight />
                              </Box>
                            )}
                          </HStack>
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
              <Text>{drilldown ? "open" : "open / drill in"}</Text>
            </HStack>
            <HStack gap={1} fontSize="xs" color="fg.muted">
              <Kbd>Esc</Kbd>
              <Text>{drilldown ? "back" : "close"}</Text>
            </HStack>
            <Spacer />
            <Button
              size="xs"
              variant="ghost"
              colorPalette="gray"
              onClick={() => {
                // Close the palette first so the help dialog doesn't render
                // behind it, then ask the shortcuts provider to open.
                onClose();
                window.dispatchEvent(new Event(OPEN_SHORTCUTS_HELP_EVENT));
              }}
              aria-label="Open keyboard shortcuts"
            >
              <HStack gap={1}>
                <FiCommand aria-hidden focusable={false} />
                <Text fontSize="xs">Keyboard shortcuts</Text>
                <Kbd>?</Kbd>
              </HStack>
            </Button>
          </Box>
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}
