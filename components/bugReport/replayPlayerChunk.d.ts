/**
 * The part of `@sentry-internal/rrweb-player` 2.35.0 that ReplayPreview uses, typed by hand
 * (see replayPlayerChunk.js for why).
 */
import type { RecordedEvent } from "@/lib/bugReport/types";

export type RrwebReplayer = {
  iframe: HTMLIFrameElement;
  play(timeOffset?: number): void;
  pause(timeOffset?: number): void;
  getCurrentTime(): number;
  on(event: "fullsnapshot-rebuilded" | "finish" | "resize", handler: (payload: unknown) => void): unknown;
  destroy(): void;
};

export type RrwebPlayerProps = {
  events: RecordedEvent[];
  width?: number;
  height?: number;
  maxScale?: number;
  autoPlay?: boolean;
  showController?: boolean;
  skipInactive?: boolean;
  mouseTail?: boolean;
  triggerFocus?: boolean;
};

export declare class RrwebPlayer {
  constructor(options: { target: HTMLElement; props: RrwebPlayerProps });
  getReplayer(): RrwebReplayer;
  triggerResize(): void;
  $set(props: Partial<RrwebPlayerProps>): void;
  $destroy(): void;
}
