/**
 * @jest-environment node
 */

import { createNoRepoSubmission } from "../../lib/edgeFunctions";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn()
}));

type RpcCall = { fn: string; args: Record<string, unknown> };

function mockSupabase(impl: (call: RpcCall) => { data: unknown; error: unknown }) {
  const calls: RpcCall[] = [];
  const rpc = jest.fn(async (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args };
    calls.push(call);
    return impl(call);
  });
  return { client: { rpc } as unknown as Parameters<typeof createNoRepoSubmission>[1], calls };
}

describe("createNoRepoSubmission", () => {
  it("forwards the assignment id and files payload to the RPC and returns the new id", async () => {
    const { client, calls } = mockSupabase(() => ({ data: 4242, error: null }));
    const id = await createNoRepoSubmission(
      {
        assignment_id: 7,
        files: [
          {
            name: "presentation.pdf",
            storage_key: "classes/1/profiles/abc/submissions/0/files/presentation.pdf",
            file_size: 12345,
            mime_type: "application/pdf"
          }
        ]
      },
      client
    );

    expect(id).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("create_no_repo_submission");
    expect(calls[0].args).toEqual({
      p_assignment_id: 7,
      p_files: [
        {
          name: "presentation.pdf",
          storage_key: "classes/1/profiles/abc/submissions/0/files/presentation.pdf",
          file_size: 12345,
          mime_type: "application/pdf"
        }
      ]
    });
  });

  it("supports submissions with no files (e.g. survey-only assignments)", async () => {
    const { client, calls } = mockSupabase(() => ({ data: 1, error: null }));
    const id = await createNoRepoSubmission({ assignment_id: 3, files: [] }, client);
    expect(id).toBe(1);
    expect(calls[0].args.p_files).toEqual([]);
  });

  it("throws an EdgeFunctionError when the RPC fails", async () => {
    const { client } = mockSupabase(() => ({
      data: null,
      error: { message: "not released yet", code: "P0001" }
    }));
    await expect(createNoRepoSubmission({ assignment_id: 1, files: [] }, client)).rejects.toThrow(
      "Failed to create no-repo submission"
    );
  });
});
