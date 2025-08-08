import { NextRequest, NextResponse } from "next/server";

/**
 * This is a proxy route that forwards the envelope to the Bugsink server.
 * @param request - The request object
 * @returns The response object
 */
export async function POST(request: NextRequest) {
  const BUGSINK_HOST = process.env.NEXT_PUBLIC_BUGSINK_HOST;
  try {
    const envelope = await request.text();

    // Parse the envelope to extract the DSN project ID
    const pieces = envelope.split("\n");
    const header = JSON.parse(pieces[0]);
    const dsn = new URL(header.dsn);
    const projectId = dsn.pathname.replace("/", "");

    // Forward to Bugsink
    const bugsinkUrl = `${BUGSINK_HOST}/api/${projectId}/envelope/`;

    const response = await fetch(bugsinkUrl, {
      method: "POST",
      body: envelope,
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        // Forward the original IP for accuracy
        "X-Forwarded-For": request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown"
      }
    });

    // Return Bugsink's response
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "text/plain"
      }
    });
  } catch (error) {
    console.error("Tunnel error:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
