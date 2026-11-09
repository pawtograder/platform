"use client";

import { Button } from "@/components/ui/button";
import type { RecordedEvent } from "@/lib/bugReport/types";
import { RRWEB_EVENT_TYPE } from "@/lib/bugReport/types";
import { Box, HStack, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuPause, LuPlay } from "react-icons/lu";

type PlayerChunk = typeof import("./replayPlayerChunk");
type Player = import("./replayPlayerChunk").RrwebPlayer;
type Replayer = import("./replayPlayerChunk").RrwebReplayer;

/** Tallest the preview gets, in CSS pixels; wide pages scale down to the dialog's width. */
const MAX_HEIGHT = 360;
const FALLBACK_WIDTH = 280;

function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function recordedViewport(events: RecordedEvent[]): { width: number; height: number } {
  const meta = events.find((e) => e.type === RRWEB_EVENT_TYPE.Meta) as
    | { data: { width?: number; height?: number } }
    | undefined;
  const width = meta?.data.width || 1280;
  const height = meta?.data.height || 720;
  return { width, height };
}

export type ReplayPreviewProps = {
  /** The redacted events, in order. Never pass unredacted events here. */
  events: RecordedEvent[];
  /** Id of the element that is the preview's text alternative (the remaining-strings list). */
  describedBy?: string;
  /** Called once the first frame has rendered. */
  onFirstFrame?: () => void;
};

/**
 * Plays a redacted recording with `@sentry-internal/rrweb-player`, loaded on first use.
 *
 * The player rebuilds the recorded page in a sandboxed iframe (no scripts). That copy of the page
 * is inert: its links and buttons can't take focus or clicks, and assistive technology skips it,
 * because the remaining-strings list next to it says everything it shows in text. The preview
 * itself is one labelled image, with a Play/Pause button below it. The player's own controller
 * is off: its icon buttons have no accessible names.
 */
export function ReplayPreview({ events, describedBy, onFirstFrame }: ReplayPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [chunk, setChunk] = useState<PlayerChunk | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [measuredWidth, setWidth] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Times playback started, for tests waiting on a whole play-through. */
  const [plays, setPlays] = useState(0);
  const [currentMs, setCurrentMs] = useState(0);
  const [ready, setReady] = useState(false);
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;

  const viewport = useMemo(() => recordedViewport(events), [events]);
  const totalMs = events.length > 1 ? events[events.length - 1].timestamp - events[0].timestamp : 0;
  // Until the dialog has laid out (or if it measures 0 mid-animation), build at a small default
  // width; the resize observer corrects it without a rebuild.
  const width = measuredWidth > 0 ? measuredWidth : FALLBACK_WIDTH;
  const height = Math.min(MAX_HEIGHT, Math.round((width * viewport.height) / viewport.width));

  useEffect(() => {
    let cancelled = false;
    import("./replayPlayerChunk")
      .then((m) => {
        if (!cancelled) setChunk(m);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // React 18 has no `inert` prop.
  useEffect(() => {
    hostRef.current?.setAttribute("inert", "");
  }, []);

  // Track the width available to the preview, so it scales down to the dialog (and to 320 px).
  useEffect(() => {
    const host = wrapRef.current;
    if (!host) return;
    // Less the preview's 1px border on each side.
    const measure = () => setWidth(Math.max(0, Math.floor(host.clientWidth) - 2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // (Re)build the player whenever the redacted events change: click-to-redact and the
  // keep-last-N control each produce a new redacted copy.
  useEffect(() => {
    const host = hostRef.current;
    if (!chunk || !host || events.length === 0) return;
    setReady(false);
    setPlaying(false);
    setCurrentMs(0);
    const player = new chunk.RrwebPlayer({
      target: host,
      props: {
        events,
        width,
        height,
        maxScale: 1,
        autoPlay: false,
        showController: false,
        skipInactive: true,
        mouseTail: false,
        triggerFocus: false
      }
    });
    playerRef.current = player;
    // The player's template (2.35.0, a Svelte 4 build) renders its root `.rr-player` twice and
    // mounts the replayer in the second copy; the first stays empty and, in our fixed-height box,
    // pushes the replay out of view. Take the empty copy out. The player never reads it again
    // (its element bindings end up on the second copy), and its $destroy only removes nodes that
    // still have a parent. 2.40.0 fixes the template, but the player stays at the recorder's version.
    for (const root of Array.from(host.querySelectorAll(":scope > .rr-player"))) {
      if (!root.querySelector(".replayer-wrapper")) root.remove();
    }
    const replayer: Replayer = player.getReplayer();
    const iframe = replayer.iframe;
    iframe.setAttribute("title", "Redacted recording preview");
    iframe.setAttribute("tabindex", "-1");
    iframe.setAttribute("aria-hidden", "true");
    let first = true;
    const onRebuilt = () => {
      if (!first) return;
      first = false;
      setReady(true);
      onFirstFrameRef.current?.();
    };
    replayer.on("fullsnapshot-rebuilded", onRebuilt);
    replayer.on("finish", () => setPlaying(false));
    // Show the first frame now, by seeking just past the first FullSnapshot (events before the
    // seek point are applied synchronously). The replayer would do it on a timer of its own,
    // taken from a throwaway iframe, which a fake clock (Playwright's page.clock) never runs.
    const firstSnapshot = events.find((e) => e.type === RRWEB_EVENT_TYPE.FullSnapshot);
    replayer.pause(firstSnapshot ? firstSnapshot.timestamp - events[0].timestamp + 1 : 0);
    const timer = window.setInterval(() => {
      try {
        setCurrentMs(replayer.getCurrentTime());
      } catch {
        // The replayer is being torn down.
      }
    }, 250);
    return () => {
      window.clearInterval(timer);
      playerRef.current = null;
      try {
        replayer.destroy();
      } catch {
        // Already gone.
      }
      player.$destroy();
      host.replaceChildren();
    };
    // `height` follows `width`; a resize is handled below without a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk, events]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.$set({ width, height });
    try {
      player.triggerResize();
    } catch {
      // Not rendered yet; the player scales itself on its first resize event.
    }
  }, [width, height]);

  const toggle = useCallback(() => {
    const replayer = playerRef.current?.getReplayer();
    if (!replayer) return;
    if (playing) {
      replayer.pause();
      setPlaying(false);
    } else {
      const at = replayer.getCurrentTime();
      replayer.play(at >= totalMs ? 0 : at);
      setPlaying(true);
      setPlays((n) => n + 1);
    }
  }, [playing, totalMs]);

  return (
    // `contain` keeps the player's fixed pixel width from widening the dialog: the width is
    // measured here and handed to the player, never the other way round.
    <Box ref={wrapRef} width="100%" minW={0} css={{ contain: "inline-size" }}>
      <Box
        role="img"
        aria-label="Preview of the redacted recording. The list of text in the recording below describes what it shows."
        aria-describedby={describedBy}
        data-testid="report-bug-replay-player"
        data-ready={ready ? "true" : "false"}
        data-event-count={events.length}
        data-playing={playing ? "true" : "false"}
        data-plays={plays}
        width="100%"
        height={`${height}px`}
        overflow="hidden"
        borderWidth="1px"
        borderRadius="md"
        bg="bg.muted"
        position="relative"
        css={{
          // The player floats and adds a drop shadow; keep it flat inside our border.
          "& .rr-player": { float: "none", boxShadow: "none", borderRadius: 0, background: "transparent" }
        }}
      >
        <div ref={hostRef} />
        {!ready && (
          <Text position="absolute" inset={0} display="flex" alignItems="center" justifyContent="center" fontSize="sm">
            {loadError ? "The preview could not be loaded." : "Loading preview"}
          </Text>
        )}
      </Box>
      <HStack mt={2} gap={3} flexWrap="wrap">
        <Button size="sm" variant="outline" onClick={toggle} disabled={!ready} data-testid="report-bug-replay-play">
          {playing ? <LuPause aria-hidden /> : <LuPlay aria-hidden />}
          {playing ? "Pause preview" : "Play preview"}
        </Button>
        <Text fontSize="sm" color="fg.muted">
          {formatTime(currentMs)} / {formatTime(totalMs)}
        </Text>
      </HStack>
    </Box>
  );
}
