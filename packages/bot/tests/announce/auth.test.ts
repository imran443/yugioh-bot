import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAnnounceSignature } from "../../src/announce/auth.js";

const secret = "test-secret";
function sign(body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyAnnounceSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"hello":"world"}';
    expect(verifyAnnounceSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyAnnounceSignature("{}", "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects when secret is missing", () => {
    expect(verifyAnnounceSignature("{}", sign("{}"), "")).toBe(false);
  });

  it("rejects malformed signature header", () => {
    expect(verifyAnnounceSignature("{}", "garbage", secret)).toBe(false);
  });
});
