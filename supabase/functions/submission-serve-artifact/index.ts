import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Open as openZip } from "npm:unzipper";
import { create, Payload, verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";
import { assertUserIsInstructorOrGrader, SecurityError, UserVisibleError } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cookie",
  "Access-Control-Allow-Credentials": "true"
};

// JWT secret for signing temporary access tokens
const getJWTSecret = async (): Promise<CryptoKey> => {
  const secret = Deno.env.get("ARTIFACT_SERVE_JWT_SECRET") || "default-secret-change-me";
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  return await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

interface ArtifactAccessToken {
  userId: string;
  courseId: number;
  profileId: string;
  submissionId: number;
  artifactId: number;
  exp: number;
}

// In-memory cache for zip buffers when function is hot
interface CacheEntry {
  buffer: Uint8Array;
  timestamp: number;
}

const zipCache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

// Clean up expired cache entries
const cleanupCache = () => {
  const now = Date.now();
  for (const [key, entry] of zipCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      zipCache.delete(key);
    }
  }
};

// Get cache key for submission and artifact
const getCacheKey = (submissionId: string, artifactId: string): string => {
  return `${submissionId}:${artifactId}`;
};

// Rewrite absolute URLs in HTML to include JWT path
const rewriteHtmlUrls = (html: string, jwtPath: string): string => {
  // Rewrite URLs that start with / to include the JWT path
  return (
    html
      // Stylesheets: <link href="/path" -> <link href="jwt/path"
      .replace(/(<link[^>]+href=["'])\/([^"']*)(["'][^>]*>)/gi, `$1${jwtPath}$2$3`)
      // Scripts: <script src="/path" -> <script src="jwt/path"
      .replace(/(<script[^>]+src=["'])\/([^"']*)(["'][^>]*>)/gi, `$1${jwtPath}$2$3`)
      // Images: <img src="/path" -> <img src="jwt/path"
      .replace(/(<img[^>]+src=["'])\/([^"']*)(["'][^>]*>)/gi, `$1${jwtPath}$2$3`)
      // Links: <a href="/path" -> <a href="jwt/path"
      .replace(/(<a[^>]+href=["'])\/([^"']*)(["'][^>]*>)/gi, `$1${jwtPath}$2$3`)
      // Generic src attributes: src="/path" -> src="jwt/path"
      .replace(/(src=["'])\/([^"']*)(["'])/gi, `$1${jwtPath}$2$3`)
      // Generic href attributes: href="/path" -> href="jwt/path"
      .replace(/(href=["'])\/([^"']*)(["'])/gi, `$1${jwtPath}$2$3`)
      // CSS url() references: url("/path") -> url("jwt/path")
      .replace(/(url\(["']?)\/([^"')]*)(["']?\))/gi, `$1${jwtPath}$2$3`)
  );
};

// MIME type mapping for common file extensions
const getMimeType = (filename: string): string => {
  const ext = filename.toLowerCase().split(".").pop() || "";
  const mimeTypes: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "application/javascript",
    mjs: "application/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    xml: "application/xml",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    eot: "application/vnd.ms-fontobject"
  };
  return mimeTypes[ext] || "application/octet-stream";
};

// Parse JWT from URL and extract artifact info
const parseJWTUrl = (url: string): { jwt: string; filePath: string } => {
  const urlPath = new URL(url).pathname;
  // Expected format: /jwt/path/to/file
  const pathParts = urlPath.split("/").filter((part) => part.length > 0);

  if (pathParts.length < 2) {
    throw new UserVisibleError("Invalid URL format. Expected: /submission-serve-artifact/jwt/path/to/file");
  }

  const jwt = pathParts[1];
  const filePath = pathParts.slice(2).join("/") || "index.html"; // Default to index.html if no file specified

  console.log("Requesting file", filePath, jwt);
  return { jwt, filePath };
};

// Handle POST request for authentication
const handleAuthRequest = async (req: Request): Promise<Response> => {
  const authToken = req.headers.get("Authorization");
  if (!authToken) {
    throw new SecurityError("No authorization header provided");
  }

  const { classId, submissionId, artifactId } = await req.json();
  const courseId = parseInt(classId);

  // Validate user permissions for the course
  const { supabase } = await assertUserIsInstructorOrGrader(courseId, authToken);

  // Get user info for JWT
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    throw new SecurityError("User not found");
  }
  const submission = await supabase.from("submissions").select("*").eq("id", submissionId).single();
  if (!submission) {
    throw new UserVisibleError("Submission not found");
  }

  // Create access token for this specific submission
  const accessToken: ArtifactAccessToken = {
    userId: user.id,
    courseId: courseId,
    submissionId: parseInt(submissionId),
    artifactId: parseInt(artifactId),
    profileId: submission.data?.profile_id ?? `${submission.data?.assignment_group_id}`,
    exp: Date.now() + 60 * 60 * 1000 // 1 hour expiry
  };

  // Sign the JWT
  const key = await getJWTSecret();
  const jwt = await create({ alg: "HS256", typ: "JWT" }, accessToken as unknown as Payload, key);

  // Construct the base URL for serving files
  const requestUrl = new URL(req.url);
  const baseUrl = `https://${requestUrl.host}/functions/v1/submission-serve-artifact`;
  const artifactUrl = `${baseUrl}/${jwt}/`;
  console.log("Artifact URL", artifactUrl);

  return new Response(JSON.stringify({ url: artifactUrl }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
};

// Verify JWT from URL
const verifyJWTFromUrl = async (jwt: string): Promise<ArtifactAccessToken> => {
  try {
    const key = await getJWTSecret();
    console.log("Verifying JWT", jwt);
    const payload = (await verify(jwt, key)) as unknown as ArtifactAccessToken;
    return payload;
  } catch (err) {
    console.error("Invalid or expired JWT", err);
    throw new SecurityError("Invalid or expired JWT");
  }
};

// Cached function for getting zip file
const getArtifactZip = async (
  classId: string,
  profileId: string,
  submissionId: string,
  artifactId: string
): Promise<Uint8Array> => {
  const cacheKey = getCacheKey(submissionId, artifactId);
  const now = Date.now();

  // Check cache first
  const cachedEntry = zipCache.get(cacheKey);
  if (cachedEntry && now - cachedEntry.timestamp < CACHE_TTL) {
    console.log(`Cache hit for ${cacheKey}`);
    return cachedEntry.buffer;
  }

  console.log(`Cache miss for ${cacheKey}, fetching from database`);

  // Clean up expired entries periodically (every 10th request)
  if (Math.random() < 0.1) {
    cleanupCache();
  }

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const artifactKey = `classes/${classId}/profiles/${profileId}/submissions/${submissionId}/${artifactId}`;
  console.log("Downloading artifact", artifactKey);
  const { data: artifact, error } = await adminSupabase.storage.from("submission-artifacts").download(artifactKey);
  if (error) {
    console.error("Error downloading artifact", error);
    throw new UserVisibleError("Artifact not found");
  }
  const arrayBuffer = await artifact.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  // Store in cache
  zipCache.set(cacheKey, {
    buffer: buffer,
    timestamp: now
  });

  console.log(`Cached zip buffer for ${cacheKey}`);
  return buffer;
};

async function handleRequest(req: Request): Promise<Response> {
  try {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    // Handle POST request for authentication
    if (req.method === "POST") {
      return await handleAuthRequest(req);
    }

    // Handle GET request for file serving
    if (req.method === "GET") {
      const { jwt, filePath } = parseJWTUrl(req.url);
      const accessToken = await verifyJWTFromUrl(jwt);

      // Get the zip file containing the static site
      const zipBuffer = await getArtifactZip(
        accessToken.courseId.toString(),
        accessToken.profileId.toString(),
        accessToken.submissionId.toString(),
        accessToken.artifactId.toString()
      );

      // Open the zip file (zipBuffer is already Uint8Array from cache)
      const zip = await openZip.buffer(zipBuffer);

      // Find the requested file in the zip
      let targetFile = zip.files.find(
        (file: any) => file.path === filePath || file.path === `${filePath}` || file.path.endsWith(`/${filePath}`)
      );

      // If exact match not found, try without leading slash
      if (!targetFile) {
        targetFile = zip.files.find((file: { path: string }) => file.path.replace(/^[^\/]+\//, "") === filePath);
      }

      // If still not found and requesting a directory, try index.html
      if (!targetFile && (filePath === "" || filePath.endsWith("/"))) {
        const indexPath = filePath + (filePath.endsWith("/") ? "" : "/") + "index.html";
        targetFile = zip.files.find(
          (file: { path: string }) => file.path === indexPath || file.path.endsWith(indexPath)
        );
      }

      if (!targetFile) {
        return new Response("File not found", {
          status: 404,
          headers: corsHeaders
        });
      }

      // Get file contents
      const fileBuffer = await targetFile.buffer();
      const mimeType = getMimeType(targetFile.path);

      let responseBody: ArrayBuffer | string = fileBuffer;

      // If it's an HTML file, rewrite URLs to include JWT path
      if (mimeType === "text/html") {
        const htmlContent = new TextDecoder().decode(fileBuffer);
        const jwtPath = `${jwt}/`;
        responseBody = rewriteHtmlUrls(htmlContent, jwtPath);
      }

      // Set up response headers
      const responseHeaders: HeadersInit = {
        ...corsHeaders,
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        "X-Content-Type-Options": "nosniff"
      };

      return new Response(responseBody, {
        status: 200,
        headers: responseHeaders
      });
    }

    // Method not allowed
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders
    });
  } catch (error) {
    console.error("Error serving artifact:", error);

    if (error instanceof SecurityError) {
      return new Response("Unauthorized", {
        status: 401,
        headers: corsHeaders
      });
    }

    if (error instanceof UserVisibleError) {
      return new Response(error.message, {
        status: 400,
        headers: corsHeaders
      });
    }

    return new Response("Internal server error", {
      status: 500,
      headers: corsHeaders
    });
  }
}

Deno.serve(async (req) => {
  return await handleRequest(req);
});
