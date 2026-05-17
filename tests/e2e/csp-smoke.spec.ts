import { expect, test, type Response } from "@playwright/test";

// Regression guard for the CSP middleware. Logging in / walking pages requires
// per-CI seeded users, but the header itself is served on every response — so
// hit unauthenticated routes and assert the shape. The XSS fix in
// `components/chat-message.tsx` is covered by code review and the production
// CSP `script-src` blocking `javascript:`-URI execution; this file only needs
// to keep the policy from silently dropping out.
async function captureCspHeader(page: import("@playwright/test").Page, path: string): Promise<string | null> {
  let header: string | null = null;
  const handler = (response: Response) => {
    if (response.request().resourceType() !== "document") return;
    if (!response.url().endsWith(path)) return;
    const h = response.headers();
    header = h["content-security-policy"] || h["content-security-policy-report-only"] || null;
  };
  page.on("response", handler);
  try {
    await page.goto(path);
  } finally {
    page.off("response", handler);
  }
  return header;
}

test("CSP header is served with the expected directives", async ({ page }) => {
  const csp = await captureCspHeader(page, "/sign-in");
  expect(csp, "CSP header on /sign-in").not.toBeNull();
  // The per-request nonce keeps Next.js's inline hydration scripts allowed.
  expect(csp!).toMatch(/script-src[^;]*'nonce-/);
  expect(csp!).toMatch(/'strict-dynamic'/);
  // Closes the usual injection / clickjacking surfaces.
  expect(csp!).toMatch(/object-src 'none'/);
  expect(csp!).toMatch(/base-uri 'self'/);
  expect(csp!).toMatch(/frame-ancestors 'none'/);
  // Critically, `'unsafe-inline'` must NOT be in script-src — that's what
  // keeps `javascript:` URI execution blocked under CSP3 and gives us the
  // belt-and-suspenders behind the chat-message.tsx fix.
  expect(csp!).not.toMatch(/script-src[^;]*'unsafe-inline'/);
});
