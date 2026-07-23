/**
 * Post-run collector for keyboard-only-navigation videos (a11y-judge).
 *
 * Runs AFTER the `playwright test` process exits — the process boundary
 * guarantees every browser context has closed and every .webm is flushed
 * (Playwright only finalizes videos on context close, so in-test copying is
 * unsound). Scans test-results/ for the a11y-video-meta.json sidecars the
 * generated replay specs write in video mode, copies each video to
 * a11y-videos/<runId>/<pageId>__<taskId>.webm, and renders a self-contained
 * index.html gallery for auditor handoff.
 *
 * Usage: tsx tools/a11y-judge/videos/collect.ts [--results test-results] [--out a11y-videos]
 */
import fs from "fs";
import path from "path";

export interface VideoMeta {
  pageId: string;
  taskId: string;
  prompt: string;
  status: string;
  expectedStatus: string;
  stepCount: number;
  durationMs: number;
  retry: number;
  videoPath: string | null;
}

export interface GalleryEntry extends VideoMeta {
  /** Relative video file name inside the run dir; null when the file is missing. */
  videoFile: string | null;
}

export function taskKey(meta: VideoMeta): string {
  return `${meta.pageId}__${meta.taskId}`;
}

/** Dedupe sidecars per task: prefer a passed attempt, else the latest retry. */
export function pickBestPerTask(metas: VideoMeta[]): VideoMeta[] {
  const best = new Map<string, VideoMeta>();
  for (const meta of metas) {
    const key = taskKey(meta);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, meta);
      continue;
    }
    const passed = (m: VideoMeta) => m.status === m.expectedStatus;
    if ((passed(meta) && !passed(prev)) || (passed(meta) === passed(prev) && meta.retry > prev.retry)) {
      best.set(key, meta);
    }
  }
  return [...best.values()].sort((a, b) => taskKey(a).localeCompare(taskKey(b)));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Pure: gallery entries → self-contained HTML (no external assets). */
export function renderGalleryHtml(entries: GalleryEntry[], runId: string): string {
  const cards = entries
    .map((entry) => {
      const passed = entry.status === entry.expectedStatus;
      const badge = passed
        ? '<span class="badge pass">PASS</span>'
        : `<span class="badge fail">${escapeHtml(entry.status.toUpperCase())}</span>`;
      const video = entry.videoFile
        ? `<video controls preload="metadata" src="${escapeHtml(entry.videoFile)}"></video>`
        : '<p class="missing">video missing (crashed or skipped run)</p>';
      return `<section class="card">
  <h2>${escapeHtml(taskKey(entry))} ${badge}</h2>
  <p class="prompt">${escapeHtml(entry.prompt)}</p>
  <p class="meta">${entry.stepCount} SR/keyboard steps · ${(entry.durationMs / 1000).toFixed(1)}s · retry ${entry.retry}</p>
  ${video}
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Keyboard-only navigation videos — ${escapeHtml(runId)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; background: #101318; color: #e8ecf1; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; }
  .card { border: 1px solid #2a3140; border-radius: 10px; padding: 1rem 1.25rem; margin: 1.25rem 0; background: #171c24; }
  .prompt { color: #b7c3d0; font-size: 0.95rem; }
  .meta { color: #7f8b99; font-size: 0.85rem; }
  .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; vertical-align: middle; margin-left: 8px; }
  .badge.pass { background: #14532d; color: #86efac; }
  .badge.fail { background: #7f1d1d; color: #fca5a5; }
  .missing { color: #fca5a5; }
  video { width: 100%; border-radius: 6px; background: #000; }
</style>
</head>
<body>
<h1>Keyboard-only navigation videos <small>(${escapeHtml(runId)})</small></h1>
<p>Each video shows a deterministic replay of a screen-reader/keyboard-only journey that completes a real
student task (machine-verified). The pink box tracks the screen-reader cursor; the caption bar shows the
command sent and what the screen reader spoke. Recorded with no mouse and no DOM access.</p>
${cards}
</body>
</html>
`;
}

function findSidecars(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) out.push(...findSidecars(p));
    else if (name === "a11y-video-meta.json") out.push(p);
  }
  return out;
}

export function collectVideos(
  resultsDir: string,
  outRoot: string,
  runId: string
): { entries: GalleryEntry[]; runDir: string } {
  const sidecars = findSidecars(resultsDir);
  const metas: (VideoMeta & { sidecarDir: string })[] = [];
  for (const sidecar of sidecars) {
    try {
      const meta = JSON.parse(fs.readFileSync(sidecar, "utf8")) as VideoMeta;
      metas.push({ ...meta, sidecarDir: path.dirname(sidecar) });
    } catch {
      console.warn(`skipping unreadable sidecar: ${sidecar}`);
    }
  }
  const best = pickBestPerTask(metas) as (VideoMeta & { sidecarDir: string })[];
  const runDir = path.join(outRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const entries: GalleryEntry[] = best.map((meta) => {
    const fileName = `${taskKey(meta)}.webm`;
    // page.video().path() promises a temp artifacts path; on context close
    // Playwright MOVES the file into the test's outputDir as video.webm. Try
    // the promised path first, then the sidecar's sibling video.webm.
    const candidates = [meta.videoPath, path.join(meta.sidecarDir, "video.webm")].filter((p): p is string =>
      Boolean(p)
    );
    const source = candidates.find((p) => fs.existsSync(p));
    if (source) {
      fs.copyFileSync(source, path.join(runDir, fileName));
      return { ...meta, videoFile: fileName };
    }
    return { ...meta, videoFile: null };
  });

  fs.writeFileSync(path.join(runDir, "index.html"), renderGalleryHtml(entries, runId));

  // Refresh the latest symlink (same convention as a11y-trajectories/latest).
  const latest = path.join(outRoot, "latest");
  try {
    fs.rmSync(latest, { force: true });
    fs.symlinkSync(runId, latest);
  } catch {
    /* symlink may fail on some FS — non-fatal */
  }
  return { entries, runDir };
}

function main(): void {
  const resultsFlag = process.argv.indexOf("--results");
  const outFlag = process.argv.indexOf("--out");
  const resultsDir = path.resolve(resultsFlag > -1 ? process.argv[resultsFlag + 1] : "test-results");
  const outRoot = path.resolve(outFlag > -1 ? process.argv[outFlag + 1] : "a11y-videos");
  const runId = process.env.A11Y_VIDEO_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");

  const { entries, runDir } = collectVideos(resultsDir, outRoot, runId);
  if (entries.length === 0) {
    console.warn(`no a11y-video-meta.json sidecars found under ${resultsDir} — did the run use A11Y_VIDEO=1?`);
    return;
  }
  const withVideo = entries.filter((e) => e.videoFile).length;
  console.log(`collected ${withVideo}/${entries.length} task videos into ${runDir}`);
  console.log(`gallery: ${path.join(runDir, "index.html")}`);
}

if (require.main === module) main();
