/**
 * @jest-environment node
 */

import { pickDefaultView } from "@/lib/submissionFiles";

const file = (id: number, name: string, is_binary = false) => ({ id, name, is_binary });
const artifact = (id: number, format: string) => ({ id, data: { format } });

describe("pickDefaultView", () => {
  it.each<[string, Parameters<typeof pickDefaultView>, ReturnType<typeof pickDefaultView>]>([
    // The bug in #1267: a paper exam opened on its scanned page instead of the answer crops.
    [
      "opens a paper exam on its exam artifact, not the page image",
      [[file(1, "exam-page-1.png", true)], [artifact(7, "exam_v1")]],
      { fileId: null, artifactId: 7 }
    ],
    // Catches letting every artifact beat files: a code assignment with a markdown report still opens on code.
    [
      "keeps a code file ahead of a non-exam artifact",
      [[file(1, "Main.java")], [artifact(7, "markdown")]],
      { fileId: 1, artifactId: null }
    ],
    // Catches losing the artifact-only fallback while moving the logic.
    [
      "opens the first artifact when there are no files",
      [[], [artifact(7, "png"), artifact(8, "zip")]],
      { fileId: null, artifactId: 7 }
    ],
    // Catches losing the code-over-markdown preference while moving the logic. README sorts first by name.
    [
      "prefers a code file over a README",
      [[file(1, "README.md"), file(2, "Main.java")], []],
      { fileId: 2, artifactId: null }
    ]
  ])("%s", (_name, [files, artifacts], expected) => {
    expect(pickDefaultView(files, artifacts)).toEqual(expected);
  });
});
