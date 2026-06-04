import { isStaleBundleError, installStaleBundleRecovery } from "@/lib/staleBundleRecovery";

describe("isStaleBundleError", () => {
  it("matches the production missing-module-factory TypeError from the webpack runtime", () => {
    // This is the exact error from the Sentry report at
    // /course/:course_id/discussion/:root_id (staff nav prefetching the surveys chunk).
    const err = new TypeError("Cannot read properties of undefined (reading 'call')");
    err.stack =
      "TypeError: Cannot read properties of undefined (reading 'call')\n" +
      "    at a (app:///_next/static/chunks/webpack-e29a8de3f44271e6.js:1:526)\n" +
      "    at 25309 (app:///_next/static/chunks/app/course/[course_id]/manage/surveys/page-a272b1fe930816c2.js:1:1860)\n" +
      "    at a (app:///_next/static/chunks/webpack-e29a8de3f44271e6.js:1:526)";
    expect(isStaleBundleError(err)).toBe(true);
  });

  it("matches a classic ChunkLoadError", () => {
    const err = new Error("Loading chunk 25309 failed.");
    err.name = "ChunkLoadError";
    expect(isStaleBundleError(err)).toBe(true);
  });

  it("matches the Firefox phrasing of the missing-factory error when stack is webpack", () => {
    const err = new TypeError("undefined is not an object (evaluating 'n.call')");
    err.stack = "x@app:///_next/static/chunks/webpack-abc.js:1:1";
    expect(isStaleBundleError(err)).toBe(true);
  });

  it("does NOT match a genuine 'reading call' TypeError from application code", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'call')");
    err.stack =
      "TypeError: Cannot read properties of undefined (reading 'call')\n" +
      "    at MyComponent (app:///_next/static/chunks/app/course/foo/SomeComponent.tsx:10:5)";
    // No webpack-runtime frame → treat as a real bug, keep reporting it.
    expect(isStaleBundleError(err)).toBe(false);
  });

  it("ignores unrelated errors", () => {
    expect(isStaleBundleError(new Error("Network request failed"))).toBe(false);
    expect(isStaleBundleError(undefined)).toBe(false);
    expect(isStaleBundleError(null)).toBe(false);
  });
});

describe("installStaleBundleRecovery", () => {
  let reloadCalls: number;
  const reload = () => {
    reloadCalls += 1;
  };

  beforeEach(() => {
    reloadCalls = 0;
    window.sessionStorage.clear();
  });

  function dispatchRejection(reason: unknown) {
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: reason });
    let prevented = false;
    event.preventDefault = () => {
      prevented = true;
    };
    window.dispatchEvent(event);
    return prevented;
  }

  it("reloads once and preventDefaults on a stale-bundle unhandled rejection", () => {
    const uninstall = installStaleBundleRecovery({ reload });
    const err = new TypeError("Cannot read properties of undefined (reading 'call')");
    err.stack = "at a (app:///_next/static/chunks/webpack-x.js:1:526)";

    const prevented1 = dispatchRejection(err);
    expect(prevented1).toBe(true);
    expect(reloadCalls).toBe(1);

    // Loop guard: a second stale-bundle error within the cooldown must NOT reload again.
    const prevented2 = dispatchRejection(err);
    expect(prevented2).toBe(true);
    expect(reloadCalls).toBe(1);

    uninstall();
  });

  it("leaves unrelated rejections alone", () => {
    const uninstall = installStaleBundleRecovery({ reload });
    const prevented = dispatchRejection(new Error("some real bug"));
    expect(prevented).toBe(false);
    expect(reloadCalls).toBe(0);
    uninstall();
  });
});
