import { NextRequest, NextResponse } from "next/server";

/**
 * This is a proxy route that forwards the envelope to the Bugsink server.
 * @param request - The request object
 * @returns The response object
 */
export async function POST(request: NextRequest) {
  const BUGSINK_HOST = process.env["NEXT_PUBLIC_BUGSINK_HOST"];
  try {
    const envelope = await request.text();

    // Parse the envelope to extract the DSN project ID
    const pieces = envelope.split("\n");
    if (pieces.length === 0) {
      // eslint-disable-next-line no-console
      console.error("Invalid envelope format: empty envelope");
      return new NextResponse("Bad Request: invalid envelope format", { status: 400 });
    }

    let header;
    let dsn;
    try {
      header = JSON.parse(pieces[0]!);
      if (!header?.dsn || typeof header.dsn !== "string") {
        throw new Error("Missing DSN in envelope header");
      }
      dsn = new URL(header.dsn);
    } catch (parseError) {
      // eslint-disable-next-line no-console
      console.error("Invalid envelope header:", parseError);
      return new NextResponse(
        `Bad Request: ${parseError instanceof Error ? parseError.message : "Invalid envelope header"}`,
        { status: 400 }
      );
    }

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
    // eslint-disable-next-line no-console
    console.error("Tunnel error:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
