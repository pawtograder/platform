import { readFileSync } from "fs";
import path from "path";
import { confirmEmailAction, signInWithEmailAction, signInWithSSOAction, signUpWithEmailAction } from "@/app/actions";

const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
jest.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));

const mockVerifyOtp = jest.fn();
const mockSignUp = jest.fn();
const mockSignInWithOAuth = jest.fn();
const mockSignInWithPassword = jest.fn();
jest.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      verifyOtp: mockVerifyOtp,
      signUp: mockSignUp,
      signInWithOAuth: mockSignInWithOAuth,
      signInWithPassword: mockSignInWithPassword
    }
  })
}));
jest.mock("@/lib/branding", () => ({
  getBranding: () => ({ name: "Pawtograder", ssoProviders: [{ provider: "azure", label: "Microsoft" }] })
}));

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
  mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://login.example/authorize" }, error: null });
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

  it("drops a trailing slash on the web URL, so the path is not //oauth/consent", async () => {
    process.env.NEXT_PUBLIC_PAWTOGRADER_WEB_URL = `${APP}/`;
    await redirectOf(() => signUpWithEmailAction("a@b.test", "pw", CONSENT));
    expect(mockSignUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${APP}${CONSENT}`);
  });

  it.each(["//evil.test", "/\\evil.test", "/\t/evil.test"])("ignores an unsafe redirect path %j", async (unsafe) => {
    mockSignUp.mockResolvedValueOnce({ data: { user: { confirmed_at: "2026-01-01T00:00:00Z" } }, error: null });
    const url = await redirectOf(() => signUpWithEmailAction("a@b.test", "pw", unsafe));
    expect(url).toBe("/course");
    expect(mockSignUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${APP}/`);
  });

  it("returns a confirmed user to the redirect path", async () => {
    mockSignUp.mockResolvedValueOnce({ data: { user: { confirmed_at: "2026-01-01T00:00:00Z" } }, error: null });
    const url = await redirectOf(() => signUpWithEmailAction("a@b.test", "pw", CONSENT));
    expect(url).toBe(CONSENT);
  });
});

describe("signInWithEmailAction", () => {
  beforeEach(() => mockSignInWithPassword.mockResolvedValue({ data: { user: { id: "u" } }, error: null }));

  it("returns to a same-origin redirect path", async () => {
    expect(await redirectOf(() => signInWithEmailAction("a@b.test", "pw", CONSENT))).toBe(CONSENT);
  });

  it.each(["//evil.test", "/\\evil.test", "/\t/evil.test"])("ignores an unsafe redirect path %j", async (unsafe) => {
    expect(await redirectOf(() => signInWithEmailAction("a@b.test", "pw", unsafe))).toBe("/course");
  });
});

describe("bundled confirmation email template", () => {
  it("passes GoTrue's RedirectTo through to /auth/confirm", () => {
    const html = readFileSync(
      path.join(__dirname, "../../charts/pawtograder/email-templates/confirmation.html"),
      "utf8"
    );
    expect(html).toContain("redirect_to={{ .RedirectTo }}");
  });
});

describe("signInWithSSOAction", () => {
  function nextOf() {
    return new URL(mockSignInWithOAuth.mock.calls[0][0].options.redirectTo).searchParams.get("next");
  }

  it("carries a same-origin redirect to the callback", async () => {
    await redirectOf(() => signInWithSSOAction(form({ sso_index: "0", redirect: CONSENT })));
    expect(nextOf()).toBe(CONSENT);
  });

  it.each(["//evil.test", "/\\evil.test", "/\t/evil.test", "/\n/evil.test"])(
    "replaces %j with the site root",
    async (redirect) => {
      await redirectOf(() => signInWithSSOAction(form({ sso_index: "0", redirect })));
      expect(nextOf()).toBe("/");
    }
  );
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
