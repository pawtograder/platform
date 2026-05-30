import { expect, testFunctional as test } from "../global-setup";
import { type Response } from "@playwright/test";

// Regression guard for the CSP middleware. Logging in / walking pages requires
// per-CI seeded users, but the header itself is served on every response — so
// hit unauthenticated routes and assert the shape. The XSS fix in
// `components/chat-message.tsx` is covered by code review and the production
// CSP `script-src` blocking `javascript:`-URI execution; this file only needs
// to keep the policy from silently dropping out.
type Captured = { csp: string | null; reportOnly: boolean; xfo: string | null };

async function captureHeaders(page: import("@playwright/test").Page, path: string): Promise<Captured> {
  const out: Captured = { csp: null, reportOnly: false, xfo: null };
  const handler = (response: Response) => {
    if (response.request().resourceType() !== "document") return;
    if (!response.url().endsWith(path)) return;
    const h = response.headers();
    if (h["content-security-policy"]) {
      out.csp = h["content-security-policy"];
      out.reportOnly = false;
    } else if (h["content-security-policy-report-only"]) {
      out.csp = h["content-security-policy-report-only"];
      out.reportOnly = true;
    }
    out.xfo = h["x-frame-options"] ?? null;
  };
  page.on("response", handler);
  try {
    await page.goto(path);
  } finally {
    page.off("response", handler);
  }
  return out;
}

test("CSP header is served with the expected directives", async ({ page }) => {
  const { csp, reportOnly, xfo } = await captureHeaders(page, "/sign-in");
  expect(csp, "CSP header on /sign-in").not.toBeNull();
  // The per-request nonce keeps Next.js's inline hydration scripts allowed.
  expect(csp!).toMatch(/script-src[^;]*'nonce-/);
  expect(csp!).toMatch(/'strict-dynamic'/);
  // Closes the usual injection surfaces.
  expect(csp!).toMatch(/object-src 'none'/);
  expect(csp!).toMatch(/base-uri 'self'/);
  // Critically, `'unsafe-inline'` must NOT be in script-src — that's what
  // keeps `javascript:` URI execution blocked under CSP3 and gives us the
  // belt-and-suspenders behind the chat-message.tsx fix.
  expect(csp!).not.toMatch(/script-src[^;]*'unsafe-inline'/);

  // Clickjacking protection. The spec ignores `frame-ancestors` in
  // report-only mode, so when running there the equivalent control is
  // X-Frame-Options. Either is acceptable; both are emitted in prod.
  if (reportOnly) {
    expect(xfo, "X-Frame-Options under report-only mode").toBe("DENY");
  } else {
    expect(csp!).toMatch(/frame-ancestors 'none'/);
  }
});
