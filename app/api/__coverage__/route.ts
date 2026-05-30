// Coverage dump endpoint. Active only when COVERAGE=1 is set in the Node
// process env — i.e., when `next start` was launched with NODE_V8_COVERAGE
// pointing at a directory. Returns 404 otherwise so this route is a no-op
// in normal production builds.
//
// Playwright hits POST /api/__coverage__ between tests to force V8 to
// flush its in-memory coverage data to NODE_V8_COVERAGE without having
// to restart the Node process. (Per-process flushing on exit is the
// default but gives us a single big merged blob with no test attribution.)

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function enabled(): boolean {
  return process.env.COVERAGE === "1" && !!process.env.NODE_V8_COVERAGE;
}

export async function POST() {
  if (!enabled()) return new NextResponse("disabled", { status: 404 });
  try {
    // Lazy require so this module doesn't pull node:v8 into the bundle
    // when coverage is off.
    const v8 = await import("node:v8");
    // takeCoverage() writes a JSON dump file into NODE_V8_COVERAGE without
    // exiting the process. Available since Node 15.
    (v8 as unknown as { takeCoverage?: () => void }).takeCoverage?.();
    return NextResponse.json({ ok: true, dir: process.env.NODE_V8_COVERAGE });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  if (!enabled()) return new NextResponse("disabled", { status: 404 });
  return NextResponse.json({ enabled: true, dir: process.env.NODE_V8_COVERAGE });
}
