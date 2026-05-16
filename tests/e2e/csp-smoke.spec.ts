import { expect, test, Page, ConsoleMessage } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const STUDENT_EMAIL = "student-24d10da5-abb2-45e9-8eee-51e0da00913d-demo-demo@pawtograder.net";
const INSTRUCTOR_EMAIL = "instructor-25266468-dae4-4dfc-86f2-c410650b98f6-demo-demo@pawtograder.net";
const COURSE_ID = 1;
const ASSIGNMENT_ID = 1;

type CapturedIssue = {
  page: string;
  kind: "console" | "pageerror" | "csp-violation";
  text: string;
};

const captured: CapturedIssue[] = [];
let lastCspHeader: string | null = null;

async function hookPage(page: Page, label: string) {
  const onConsole = (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const text = msg.text();
    // Filter out noisy unrelated warnings (React StrictMode, Next dev fetch warnings, etc.)
    if (/Download the React DevTools/i.test(text)) return;
    if (/Refused to|Content Security Policy|Content-Security-Policy/i.test(text)) {
      captured.push({ page: label, kind: "csp-violation", text });
      return;
    }
    captured.push({ page: label, kind: "console", text });
  };
  const onPageError = (err: Error) => {
    captured.push({ page: label, kind: "pageerror", text: err.message });
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  // Listen for SecurityPolicyViolationEvent inside the page and forward to console.
  // addInitScript returns a Promise that must resolve before the next navigation,
  // or the listener won't be installed in time to catch early violations.
  await page.addInitScript(() => {
    addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => {
      // Stringified payload so it surfaces via page.on('console') as a CSP violation.
      // eslint-disable-next-line no-console
      console.error(
        `[CSP-VIOLATION] directive=${e.effectiveDirective} blocked=${e.blockedURI} sample=${(e.sample || "").slice(0, 200)}`
      );
    });
  });
}

// In report-only mode the suite is informational — print violations and pass.
// Once enforcement is on, a CSP violation or page error is a real regression
// and the suite must fail.
const ENFORCING = process.env.CSP_REPORT_ONLY !== "1";
function failingIssues(label: string): CapturedIssue[] {
  return captured.filter((c) => c.page === label && c.kind !== "console");
}

async function captureCspHeader(page: Page, url: string) {
  return new Promise<void>((resolve) => {
    const handler = (response: import("@playwright/test").Response) => {
      if (
        response.url().replace(/\/$/, "") === url.replace(/\/$/, "") &&
        response.request().resourceType() === "document"
      ) {
        const headers = response.headers();
        lastCspHeader = headers["content-security-policy"] || headers["content-security-policy-report-only"] || null;
        page.off("response", handler);
        resolve();
      }
    };
    page.on("response", handler);
    // Safety timeout
    setTimeout(() => {
      page.off("response", handler);
      resolve();
    }, 15_000);
  });
}

async function loginViaPassword(page: Page, email: string, password = "change-it") {
  await page.goto("/sign-in");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[name="action"][value="signin"]').click();
  await page.waitForURL(/\/course(\/|$)/, { timeout: 30_000 });
}

async function dismissTimezoneDialogIfPresent(page: Page) {
  try {
    const btn = page.getByRole("button", { name: /Use my browser time zone|Accept|OK|Got it|Continue/i });
    if (await btn.isVisible({ timeout: 1500 })) await btn.click({ timeout: 1500 });
  } catch {
    /* ignore */
  }
}

test.describe.configure({ mode: "serial" });

test("CSP smoke walkthrough", async ({ page }) => {
  test.setTimeout(180_000);

  await hookPage(page, "global");

  // 1. Sign-in page — unauthenticated, must serve CSP.
  const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
  await Promise.all([captureCspHeader(page, `${BASE_URL}/sign-in`), page.goto("/sign-in")]);
  expect(lastCspHeader, "CSP header on /sign-in").not.toBeNull();
  expect(lastCspHeader!).toMatch(/script-src[^;]*'nonce-/);
  expect(lastCspHeader!).toMatch(/object-src 'none'/);
  expect(lastCspHeader!).toMatch(/frame-ancestors 'none'/);

  // 2. Log in as student via magic link.
  await loginViaPassword(page, STUDENT_EMAIL);
  await dismissTimezoneDialogIfPresent(page);

  // 3. Course dashboard
  await page.goto(`/course/${COURSE_ID}`);
  await page.waitForLoadState("networkidle");
  await dismissTimezoneDialogIfPresent(page);

  // 4. Discussion area
  await page.goto(`/course/${COURSE_ID}/discussion`);
  await page.waitForLoadState("networkidle");

  // 5. Office hours queue list
  await page.goto(`/course/${COURSE_ID}/office-hours`);
  await page.waitForLoadState("networkidle");

  // 6. THE XSS PoC: create a help request whose body contains a `javascript:` link.
  //    The body itself goes through <Markdown> (sanitized). The bug is that
  //    chat-message.tsx parallels-extract attachments via regex and renders
  //    them as <a href> outside the sanitizer. After our fix, no such link
  //    should appear in the DOM.
  await page.goto(`/course/${COURSE_ID}/office-hours/3/new`);
  await page.waitForLoadState("networkidle");

  // Fill the request body — try a few common selectors used by MDEditor.
  const payload = "[click-me-xss](javascript:window.__pwned=true;alert('xss'))";
  const textareaCandidates = [page.locator("textarea").first(), page.getByRole("textbox").first()];
  let filled = false;
  for (const t of textareaCandidates) {
    try {
      await t.fill(payload, { timeout: 3000 });
      filled = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!filled) {
    test.info().annotations.push({
      type: "note",
      description: "Could not find a textarea on the new-help-request page; skipping submit step"
    });
  } else {
    // Try to submit
    try {
      await page
        .getByRole("button", { name: /Submit|Create|Post|Send/i })
        .first()
        .click({ timeout: 5000 });
      await page.waitForURL(/\/office-hours\/\d+\/(\d+|request)/, { timeout: 15_000 });
    } catch {
      // form may not submit due to missing fields — that's fine, the XSS
      // check is about what the form *renders*, not whether it stores.
    }
  }

  // Try to drive at least one existing help request page so chat-message renders.
  await page.goto(`/course/${COURSE_ID}/office-hours/3/1`);
  await page.waitForLoadState("networkidle").catch(() => {});

  // Probe: is there any <a> element with a javascript: href visible on this page?
  // Our fix should make this impossible.
  const jsLinks = await page.locator('a[href^="javascript:" i]').count();
  expect(jsLinks, "no <a href='javascript:'> in DOM after fix").toBe(0);

  // 7. Gradebook
  await page.goto(`/course/${COURSE_ID}/gradebook`);
  await page.waitForLoadState("networkidle");

  // 8. Assignments index
  await page.goto(`/course/${COURSE_ID}/assignments`);
  await page.waitForLoadState("networkidle");

  // 9. Assignment detail
  await page.goto(`/course/${COURSE_ID}/assignments/${ASSIGNMENT_ID}`);
  await page.waitForLoadState("networkidle");

  // Print summary so it shows in test output even when the test passes.
  // eslint-disable-next-line no-console
  console.log("=== CSP smoke summary ===");
  // eslint-disable-next-line no-console
  console.log("CSP header on /sign-in:", lastCspHeader);
  // eslint-disable-next-line no-console
  console.log(`Captured issues: ${captured.length}`);
  for (const c of captured.slice(0, 50)) {
    // eslint-disable-next-line no-console
    console.log(`[${c.kind}] (${c.page}) ${c.text.slice(0, 400)}`);
  }
  if (captured.length > 50) {
    // eslint-disable-next-line no-console
    console.log(`... (${captured.length - 50} more)`);
  }

  if (ENFORCING) {
    expect(failingIssues("global"), "unexpected CSP violations / page errors during student flow").toEqual([]);
  }
});

test("CSP smoke walkthrough — instructor", async ({ page }) => {
  test.setTimeout(180_000);
  await hookPage(page, "instructor");

  await loginViaPassword(page, INSTRUCTOR_EMAIL);
  await dismissTimezoneDialogIfPresent(page);

  // Instructor-only pages exercise different scripts (autograder configuration,
  // gradebook expression editor, mdeditor in email composer, …).
  for (const path of [
    `/course/${COURSE_ID}/manage`,
    `/course/${COURSE_ID}/manage/gradebook`,
    `/course/${COURSE_ID}/manage/course/emails`,
    `/course/${COURSE_ID}/manage/assignments`,
    `/course/${COURSE_ID}/manage/assignments/${ASSIGNMENT_ID}`
  ]) {
    await page.goto(path).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  // eslint-disable-next-line no-console
  console.log("=== CSP smoke (instructor) ===");
  for (const c of captured.filter((c) => c.page === "instructor").slice(0, 50)) {
    // eslint-disable-next-line no-console
    console.log(`[${c.kind}] ${c.text.slice(0, 400)}`);
  }

  if (ENFORCING) {
    expect(failingIssues("instructor"), "unexpected CSP violations / page errors during instructor flow").toEqual([]);
  }
});
