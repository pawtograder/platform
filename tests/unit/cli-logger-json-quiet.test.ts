/**
 * @jest-environment node
 */

/**
 * `--json` has to leave stdout parseable.
 *
 * Every logger method except `error` writes to stdout, and some commands log progress
 * *before* the request whose response `emitJson` prints — `rubrics import` announces the
 * parsed file, then calls the API. A consumer piping stdout to a parser therefore
 * received progress text ahead of the JSON. The CLI silences the logger from a yargs
 * middleware when `--json` is set, so this is the contract that has to hold.
 */

import { logger, setLoggerQuiet } from "../../cli/utils/logger";
import { emitJson } from "../../cli/utils/output";

describe("logger under --json", () => {
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stdout = jest.spyOn(console, "log").mockImplementation(() => {});
    stderr = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setLoggerQuiet(false);
    jest.restoreAllMocks();
  });

  it("writes progress to stdout by default", () => {
    logger.step("working");
    logger.info("detail");
    logger.success("done");
    logger.warning("careful");
    logger.progress(1, 2, "half");
    logger.blank();
    logger.raw("raw");
    expect(stdout).toHaveBeenCalledTimes(7);
  });

  it("writes nothing to stdout once quiet", () => {
    setLoggerQuiet(true);
    logger.step("working");
    logger.info("detail");
    logger.success("done");
    logger.warning("careful");
    logger.progress(1, 2, "half");
    logger.blank();
    logger.raw("raw");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("still reports errors, because stderr is not the parsed stream", () => {
    setLoggerQuiet(true);
    logger.error("broke");
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("leaves stdout holding only the JSON payload", () => {
    setLoggerQuiet(true);
    logger.step("Importing rubric");
    logger.info("  Parts: 3");
    expect(emitJson({ json: true }, { ok: true })).toBe(true);

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0][0] as string)).toEqual({ ok: true });
  });

  it("is reversible, so one command's flag cannot leak into a later one", () => {
    setLoggerQuiet(true);
    logger.info("hidden");
    setLoggerQuiet(false);
    logger.info("shown");
    expect(stdout).toHaveBeenCalledTimes(1);
  });
});
