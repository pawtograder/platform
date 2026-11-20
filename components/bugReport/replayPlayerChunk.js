/**
 * The rrweb player and its stylesheet, as one lazily loaded chunk. `ReplayPreview` imports this
 * module with `import()` when a review opens, so the player (and the rrweb replayer inside it)
 * is never in the main bundle and never loads with the course flag off (test A1).
 *
 * Plain JavaScript with a hand-written `.d.ts` beside it, because the player's own type
 * declarations augment the global `Document` in a way that breaks other files' types.
 */
import "@sentry-internal/rrweb-player/dist/style.css";

export { default as RrwebPlayer } from "@sentry-internal/rrweb-player";
