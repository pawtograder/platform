/**
 * Tests for lib/surveyResponseKeepalive.ts: the draft write the survey page sends while it unloads.
 * It must be the same PostgREST upsert the Supabase client sends, so the same RLS applies, and it
 * must ask the browser to keep it alive past the page.
 */
import {
  KEEPALIVE_BODY_LIMIT_BYTES,
  SurveyResponseWriteError,
  upsertSurveyResponseWithKeepalive
} from "@/lib/surveyResponseKeepalive";

const row = {
  survey_id: "survey-1",
  profile_id: "profile-1",
  response: { q1: "typed before reload" },
  is_submitted: false
};

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

const send = (overrides: Partial<Parameters<typeof upsertSurveyResponseWithKeepalive>[0]> = {}) =>
  upsertSurveyResponseWithKeepalive({
    supabaseUrl: "http://127.0.0.1:54321",
    anonKey: "anon-key",
    accessToken: "student-token",
    row,
    ...overrides
  });

test("posts the row as the same upsert the Supabase client sends, kept alive past the page", async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 201 });
  const signal = new AbortController().signal;

  await send({ signal });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://127.0.0.1:54321/rest/v1/survey_responses?on_conflict=survey_id,profile_id");
  expect(init).toMatchObject({
    method: "POST",
    keepalive: true,
    signal,
    headers: {
      apikey: "anon-key",
      Authorization: "Bearer student-token",
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    }
  });
  expect(JSON.parse(init.body)).toEqual(row);
});

test("sends a body over the keepalive limit as an ordinary request rather than not at all", async () => {
  fetchMock.mockResolvedValue({ ok: true, status: 201 });

  await send({ row: { ...row, response: { q1: "x".repeat(KEEPALIVE_BODY_LIMIT_BYTES) } } });

  expect(fetchMock.mock.calls[0][1].keepalive).toBe(false);
});

// A row whose JSON body takes about two thirds of the keepalive limit: one fits, two at once don't.
const rowOfTwoThirds = () => ({
  ...row,
  response: { q1: "x".repeat(Math.floor((KEEPALIVE_BODY_LIMIT_BYTES * 2) / 3)) }
});

type FetchResult = { ok: boolean; status: number };

test("does not ask for keepalive when the keepalive requests still in flight would pass the limit together", async () => {
  let finishFirst!: (result: FetchResult) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<FetchResult>((resolve) => {
        finishFirst = resolve;
      })
  );
  fetchMock.mockResolvedValue({ ok: true, status: 201 });

  // The first request is still waiting for the server when the second goes out.
  const first = send({ row: rowOfTwoThirds() });
  await send({ row: rowOfTwoThirds() });
  expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
  expect(fetchMock.mock.calls[1][1].keepalive).toBe(false);

  // Once the first is done, its share is free again.
  finishFirst({ ok: true, status: 201 });
  await first;
  await send({ row: rowOfTwoThirds() });
  expect(fetchMock.mock.calls[2][1].keepalive).toBe(true);
});

test("frees the share of a keepalive request that fails", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  fetchMock.mockResolvedValue({ ok: true, status: 201 });

  await expect(send({ row: rowOfTwoThirds() })).rejects.toThrow("Failed to fetch");
  await send({ row: rowOfTwoThirds() });

  expect(fetchMock.mock.calls[1][1].keepalive).toBe(true);
});

test("rejects with the PostgREST error when the server refuses the upsert", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 403,
    json: async () => ({ code: "42501", message: "new row violates row-level security policy" })
  });

  const error = await send().catch((caught) => caught);

  expect(error).toBeInstanceOf(SurveyResponseWriteError);
  expect(error).toMatchObject({ status: 403, code: "42501", message: "new row violates row-level security policy" });
});
