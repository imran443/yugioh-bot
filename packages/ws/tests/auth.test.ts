import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyBroadcastSignature } from "../src/auth.js";

const SECRET = "shh";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyBroadcastSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ slug: "abc", status: "active" });
    expect(verifyBroadcastSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects when signature is missing", () => {
    expect(verifyBroadcastSignature("{}", undefined, SECRET)).toBe(false);
  });

  it("rejects when signature does not match", () => {
    expect(verifyBroadcastSignature("{}", "sha256=deadbeef", SECRET)).toBe(false);
  });

  it("rejects when secret is empty", () => {
    expect(verifyBroadcastSignature("{}", sign("{}"), "")).toBe(false);
  });

  it("rejects unknown algorithm prefix", () => {
    expect(verifyBroadcastSignature("{}", "md5=abc", SECRET)).toBe(false);
  });
});
