/**
 * The OAuth consent page sends a signed-out visitor to /sign-in?redirect=/oauth/consent?..., and a
 * signup that needs email confirmation has to bring them back there once they click the link.
 */
import { confirmEmailAction, signUpWithEmailAction } from "@/app/actions";

const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
jest.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));

const mockVerifyOtp = jest.fn();
const mockSignUp = jest.fn();
jest.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: mockVerifyOtp, signUp: mockSignUp } })
}));
jest.mock("@/lib/branding", () => ({ getBranding: () => ({ name: "Pawtograder", ssoProviders: [] }) }));

const APP = "https://app.example";
const CONSENT = "/oauth/consent?authorization_id=abc";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function redirectOf(run: () => Promise<unknown>) {
  await expect(run()).rejects.toThrow("NEXT_REDIRECT");
  return mockRedirect.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL = APP;
  process.env.ENABLE_SIGNUPS = "true";
  mockVerifyOtp.mockResolvedValue({ error: null });
  mockSignUp.mockResolvedValue({ data: { user: { confirmed_at: null } }, error: null });
});

describe("signUpWithEmailAction", () => {
  it("puts the redirect path in emailRedirectTo", async () => {
    await redirectOf(() => signUpWithEmailAction("a@b.test", "pw", CONSENT));
    expect(mockSignUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${APP}${CONSENT}`);
  });

  it("keeps the site root when there is no redirect path", async () => {
    await redirectOf(() => signUpWithEmailAction("a@b.test", "pw"));
    expect(mockSignUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${APP}/`);
  });
});

describe("confirmEmailAction", () => {
  it("returns to the path the signup asked for", async () => {
    const url = await redirectOf(() => confirmEmailAction(form({ token_hash: "t", redirect_to: `${APP}${CONSENT}` })));
    expect(url).toBe(CONSENT);
  });

  it.each([
    ["no redirect_to", {}],
    ["GoTrue's site URL fallback", { redirect_to: APP }],
    ["the site root", { redirect_to: `${APP}/` }],
    ["another origin", { redirect_to: "https://evil.test/oauth/consent" }],
    ["a protocol-relative URL", { redirect_to: "//evil.test" }],
    ["a backslash path", { redirect_to: "/\\evil.test" }],
    ["a // path on the app's origin", { redirect_to: `${APP}//evil.test` }]
  ])("falls back to /course for %s", async (_label, fields) => {
    const url = await redirectOf(() => confirmEmailAction(form({ token_hash: "t", ...fields })));
    expect(url).toBe("/course");
  });

  it("does not follow redirect_to when verification fails", async () => {
    mockVerifyOtp.mockResolvedValue({ error: { message: "Token has expired" } });
    const url = await redirectOf(() => confirmEmailAction(form({ token_hash: "t", redirect_to: `${APP}${CONSENT}` })));
    expect(url).toMatch(/^\/auth\/confirm\?error=Token%20has%20expired/);
  });
});
