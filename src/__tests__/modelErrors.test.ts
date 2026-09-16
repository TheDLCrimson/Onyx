import { describe, expect, it } from "vitest";
import { APIConnectionError, APIError } from "openai";
import { describeModelError } from "../utils/modelErrors";
import { errText } from "../utils/discord";

/** Build an SDK error the way the OpenAI client does for an HTTP failure. */
function apiError(status: number, message: string): APIError {
  return APIError.generate(status, { message }, message, new Headers());
}

describe("describeModelError()", () => {
  it("returns null for non-model errors so callers keep the raw message", () => {
    expect(describeModelError(new Error("GitHub 404"))).toBeNull();
    expect(describeModelError({ status: 429 })).toBeNull();
    expect(describeModelError("boom")).toBeNull();
  });

  it("explains 429 rate limits and points at fallbacks", () => {
    const text = describeModelError(apiError(429, "Provider returned error"));
    expect(text).toContain("rate-limiting");
    expect(text).toContain("free models");
  });

  it("explains 402 as an operator-side credit problem", () => {
    expect(describeModelError(apiError(402, "Insufficient credits"))).toContain("credits");
  });

  it("points at the API key on 401", () => {
    expect(describeModelError(apiError(401, "No auth"))).toContain("OPENROUTER_API_KEY");
  });

  it("treats 5xx as transient provider trouble", () => {
    expect(describeModelError(apiError(502, "Upstream error"))).toContain(
      "temporarily unavailable (502)",
    );
  });

  it("surfaces the provider detail and a config hint for an invalid model id", () => {
    const text = describeModelError(apiError(400, "foo/bar is not a valid model ID"));
    expect(text).toContain("foo/bar is not a valid model ID. Check");
    expect(text).toContain("ONYX_MODEL");
    expect(text).not.toMatch(/\(400\): 400/);
  });

  it("caps very long provider messages", () => {
    const text = describeModelError(apiError(400, "x".repeat(1000)))!;
    expect(text.length).toBeLessThan(300);
  });

  it("describes connection failures", () => {
    const err = new APIConnectionError({ message: "fetch failed" });
    expect(describeModelError(err)).toContain("Couldn't reach OpenRouter");
  });
});

describe("errText()", () => {
  it("routes model errors through describeModelError", () => {
    expect(errText(apiError(429, "Provider returned error"))).toContain("rate-limiting");
  });

  it("keeps plain Error messages unchanged", () => {
    expect(errText(new Error("plain failure"))).toBe("plain failure");
  });
});
