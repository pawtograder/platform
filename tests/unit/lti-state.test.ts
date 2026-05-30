/**
 * @jest-environment node
 */
import { createState, randomNonce, verifyState } from "@/lib/lti/state";

beforeAll(() => {
  process.env.LTI_STATE_SECRET = "test-state-secret-which-is-long-enough-1234567890";
});

describe("OIDC state", () => {
  test("create → verify round-trips the payload", async () => {
    const token = await createState({
      nonce: "n-123",
      iss: "https://canvas.test",
      clientId: "client-9",
      targetLinkUri: "https://tool/launch"
    });
    const decoded = await verifyState(token);
    expect(decoded.nonce).toBe("n-123");
    expect(decoded.iss).toBe("https://canvas.test");
    expect(decoded.clientId).toBe("client-9");
    expect(decoded.targetLinkUri).toBe("https://tool/launch");
  });

  test("a tampered token fails verification", async () => {
    const token = await createState({ nonce: "n", iss: "https://canvas.test" });
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    await expect(verifyState(tampered)).rejects.toBeDefined();
  });

  test("a token signed with a different secret fails", async () => {
    const token = await createState({ nonce: "n", iss: "https://canvas.test" });
    const prev = process.env.LTI_STATE_SECRET;
    process.env.LTI_STATE_SECRET = "a-totally-different-secret-value-aaaaaaaaaaaaaaa";
    await expect(verifyState(token)).rejects.toBeDefined();
    process.env.LTI_STATE_SECRET = prev;
  });
});

describe("randomNonce", () => {
  test("produces unique values", () => {
    expect(randomNonce()).not.toBe(randomNonce());
    expect(randomNonce().length).toBeGreaterThan(20);
  });
});
