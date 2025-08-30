import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

type TimeZonePreference = "course" | "browser";

/**
 * Build the per-course cookie key for storing the user's time zone preference.
 */
function getCookieKey(courseId: number): string {
  return `tz_pref_course_${courseId}`;
}

/**
 * GET /api/timezone-preference?courseId=123
 *
 * Returns JSON with the saved preference for the given course if present:
 * { preference: "course" | "browser" } or { preference: undefined }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const courseIdParam = searchParams.get("courseId");
  const courseId = Number(courseIdParam);

  if (!courseIdParam || Number.isNaN(courseId) || courseId <= 0) {
    return NextResponse.json({ error: "Invalid courseId" }, { status: 400 });
  }

  const cookieStore = await cookies();
  const key = getCookieKey(courseId);
  const cookie = cookieStore.get(key);
  const value = cookie?.value as TimeZonePreference | undefined;

  if (value !== "course" && value !== "browser") {
    return NextResponse.json({ preference: undefined }, { status: 200 });
  }

  return NextResponse.json({ preference: value }, { status: 200 });
}

/**
 * POST /api/timezone-preference
 * Body: { courseId: number, choice: "course" | "browser" }
 *
 * Sets an httpOnly cookie with security attributes to store the preference.
 */
export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const body = payload as Partial<{ courseId: number; choice: TimeZonePreference }>;
  const courseId = Number(body.courseId);
  const choice = body.choice;

  if (!courseId || Number.isNaN(courseId) || courseId <= 0) {
    return NextResponse.json({ error: "Invalid courseId" }, { status: 400 });
  }
  if (choice !== "course" && choice !== "browser") {
    return NextResponse.json({ error: "Invalid choice" }, { status: 400 });
  }

  const key = getCookieKey(courseId);

  // 180 days
  const maxAgeSeconds = 60 * 60 * 24 * 180;
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set({
    name: key,
    value: choice,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds
  });
  return res;
}
