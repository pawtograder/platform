/**
 * @jest-environment node
 */

import { createTokenizer } from "@/supabase/functions/cli/utils/tokenization";
import { buildFileExportRecord } from "@/supabase/functions/cli/utils/submissionFileExportRecord";

describe("submissions export file records", () => {
  const SALT = "test-salt-at-least-16-chars-long-aaaa";
  const PEPPER = "test-pepper-at-least-32-characters-long-for-export";

  it("includes inline contents for text files", () => {
    const record = buildFileExportRecord({
      submissionId: 42,
      submissionToken: "abc123token45678",
      name: "src/Main.java",
      is_binary: false,
      contents: "public class Main {}",
      mime_type: "text/x-java",
      file_size: 18,
      withBinary: false
    });

    expect(record.kind).toBe("file");
    expect(record.contents).toBe("public class Main {}");
    expect(record.content_base64).toBeNull();
    expect(record.binary_omitted).toBe(false);
    expect(record.submission).toEqual({ token: "abc123token45678" });
  });

  it("omits binary bytes when withBinary is false", () => {
    const record = buildFileExportRecord({
      submissionId: 7,
      submissionToken: "subtoken12345678",
      name: "image.png",
      is_binary: true,
      content_base64: "aGVsbG8=",
      withBinary: false
    });

    expect(record.contents).toBeNull();
    expect(record.content_base64).toBeNull();
    expect(record.binary_omitted).toBe(true);
  });

  it("includes base64 for binary files when withBinary is true", () => {
    const record = buildFileExportRecord({
      submissionId: 7,
      submissionToken: "subtoken12345678",
      name: "image.png",
      is_binary: true,
      content_base64: "aGVsbG8=",
      withBinary: true
    });

    expect(record.content_base64).toBe("aGVsbG8=");
    expect(record.binary_omitted).toBe(false);
    expect(record.contents).toBeNull();
  });

  it("uses raw submission id in raw identity mode", () => {
    const record = buildFileExportRecord({
      submissionId: 99,
      name: "README.md",
      is_binary: false,
      contents: "# hi",
      withBinary: false
    });

    expect(record.submission).toEqual({ id: 99 });
  });

  it("produces stable submission tokens joinable with assessment export", async () => {
    const t1 = await createTokenizer(SALT, PEPPER);
    const t2 = await createTokenizer(SALT, PEPPER);
    const submissionToken = await t1.token("submission", 1234);
    expect(await t2.token("submission", 1234)).toBe(submissionToken);

    const record = buildFileExportRecord({
      submissionId: 1234,
      submissionToken,
      name: "foo.txt",
      is_binary: false,
      contents: "bar",
      withBinary: false
    });
    expect(record.submission).toEqual({ token: submissionToken });
  });
});
