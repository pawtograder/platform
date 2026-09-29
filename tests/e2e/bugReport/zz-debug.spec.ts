import { test } from "../../global-setup";
import { createClass, createUsersInClass, loginAsUser } from "../TestingUtils";
import { enableRecording, waitForRecorderState } from "./recorderTestUtils";

test("debug taint block", async ({ page }) => {
  const course = await createClass({ name: "dbg" });
  const [s] = await createUsersInClass([{ role: "student", class_id: course.id, name: "Dbg Student", useMagicLink: true }]);
  await enableRecording(page, course.id, [{ pattern: "/course/[course_id]/e2e-harness/bug-report", level: "full" }]);
  await loginAsUser(page, s, course);
  const v = { name: "Qorvik Blemmar", otherName: "Xan Tolvik", email: "zz@pawtograder.net", handle: "qorv-12" };
  await page.goto(`/course/${course.id}/e2e-harness/bug-report?fixture=leaks&v=${encodeURIComponent(JSON.stringify(v))}`);
  await waitForRecorderState(page, "recording");
  await page.getByTestId("leak-fixture").waitFor();
  const html = await page.content();
  console.log("HAS report-taint in DOM:", html.includes("report-taint"), "scripts:", (html.match(/<script[^>]*application\/json[^>]*>/g) ?? []).join(" | "));
  const resp = await page.request.get(page.url());
  const raw = await resp.text();
  const i = raw.indexOf("report-taint");
  console.log("raw html has report-taint:", i, raw.slice(Math.max(0, i - 100), i + 200));
  await page.waitForFunction(() => window.__bugReportRedaction !== undefined);
  const info = await page.evaluate(async () => ({
    blocks: Array.from(document.querySelectorAll("script#report-taint")).map((s) => [s.getAttribute("type"), s.textContent]),
    remaining: (await window.__bugReportRedaction!.redact()).remaining.slice(0, 15)
  }));
  console.log(JSON.stringify(info, null, 1));
});
