import { describe, expect, it, vi } from "vitest";
import { describeLoginFailure, loginOrExit, type Loggable } from "../utils/startup";

/** Build an error carrying a Node TLS/system error code. */
function codedError(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

/** A client whose login resolves. */
function okClient(): Loggable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    login: vi.fn(async (token: string) => {
      calls.push(token);
      return token;
    }),
  } as unknown as Loggable & { calls: string[] };
}

/** A client whose login rejects with `error`. */
function failingClient(error: unknown): Loggable {
  return { login: vi.fn(async () => Promise.reject(error)) } as unknown as Loggable;
}

describe("describeLoginFailure", () => {
  it("names both remedies for an intercepted TLS chain", () => {
    const text = describeLoginFailure(codedError("UNABLE_TO_VERIFY_LEAF_SIGNATURE"));
    expect(text).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(text).toContain("NODE_EXTRA_CA_CERTS");
    expect(text).toContain("--use-system-ca");
  });

  it("treats the other self-signed codes the same way", () => {
    for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      expect(describeLoginFailure(codedError(code))).toContain("NODE_EXTRA_CA_CERTS");
    }
  });

  it("points at DISCORD_TOKEN when the token is rejected", () => {
    const text = describeLoginFailure(new Error("An invalid token was provided."));
    expect(text).toContain("DISCORD_TOKEN");
  });

  it("passes an unrecognised error through unchanged", () => {
    expect(describeLoginFailure(new Error("getaddrinfo ENOTFOUND"))).toBe("getaddrinfo ENOTFOUND");
  });

  it("does not throw on a non-Error value", () => {
    expect(describeLoginFailure("plain string")).toBe("plain string");
    expect(describeLoginFailure(null)).toBe("null");
  });

  it("ignores a non-string code", () => {
    const weird = Object.assign(new Error("nope"), { code: 42 });
    expect(describeLoginFailure(weird)).toBe("nope");
  });
});

describe("loginOrExit", () => {
  it("logs in with the trimmed token and does not exit", async () => {
    const client = okClient();
    const exit = vi.fn();
    const log = vi.fn();

    await loginOrExit(client, "  abc123  ", exit, log);

    expect(client.calls).toEqual(["abc123"]);
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("exits non-zero when login fails", async () => {
    const exit = vi.fn();
    const log = vi.fn();

    await loginOrExit(failingClient(codedError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "t", exit, log);

    // Exit code 0 would read as a clean stop to Docker/Railway/Kubernetes,
    // turning a bot that never connects into a silent restart loop.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs the actionable reason before exiting", async () => {
    const exit = vi.fn();
    const log = vi.fn();

    await loginOrExit(failingClient(codedError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "t", exit, log);

    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0][0] as string;
    expect(message).toContain("could not log in to Discord");
    expect(message).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("never rethrows, so the caller's void call cannot become an unhandled rejection", async () => {
    const exit = vi.fn();
    const log = vi.fn();

    await expect(
      loginOrExit(failingClient(new Error("network down")), "t", exit, log),
    ).resolves.toBeUndefined();
  });

  it("treats a missing token as empty rather than crashing", async () => {
    const client = okClient();
    const exit = vi.fn();

    await loginOrExit(client, undefined, exit, vi.fn());

    expect(client.calls).toEqual([""]);
  });
});
