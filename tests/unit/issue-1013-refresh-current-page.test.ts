import { refreshCurrentPage } from "@/lib/refreshCurrentPage";

const mockDelete = jest.fn();
jest.mock("next/headers", () => ({
  cookies: async () => ({ delete: mockDelete })
}));

describe("refreshCurrentPage", () => {
  const originalBuild = process.env.NEXT_PUBLIC_GIT_COMMIT_SHA;

  beforeEach(() => {
    mockDelete.mockClear();
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA = originalBuild;
  });

  it("re-renders the page when the tab is on this build", async () => {
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA = "this-build";
    await expect(refreshCurrentPage("this-build")).resolves.toBe(true);
    expect(mockDelete).toHaveBeenCalledWith("refresh-current-page");
  });

  it.each([
    ["another build", "other-build"],
    ["a build with no SHA", ""],
    ["nothing", undefined]
  ])("sends no tree to a tab on %s", async (_name, clientBuild) => {
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA = "this-build";
    await expect(refreshCurrentPage(clientBuild)).resolves.toBe(false);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("can't tell two builds apart when neither has a SHA, so it refreshes", async () => {
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA = "";
    await expect(refreshCurrentPage("")).resolves.toBe(true);
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});
