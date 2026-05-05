import { describe, expect, it } from "vitest";
import { EnvdError, type ErrorCode } from "../../src/shared/errors.js";

describe("EnvdError", () => {
  it("extends Error", () => {
    const err = new EnvdError("something went wrong", { code: "internal" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EnvdError);
  });

  it("sets name to EnvdError", () => {
    const err = new EnvdError("msg", { code: "internal" });
    expect(err.name).toBe("EnvdError");
  });

  it("carries the error code", () => {
    const err = new EnvdError("daemon not running", {
      code: "daemon_unreachable",
    });
    expect(err.code).toBe("daemon_unreachable");
  });

  it("carries optional details", () => {
    const err = new EnvdError("auth failed", {
      code: "provider_auth",
      details: { provider: "doppler", statusCode: 401 },
    });
    expect(err.details).toEqual({ provider: "doppler", statusCode: 401 });
  });

  it("details is undefined when not provided", () => {
    const err = new EnvdError("oops", { code: "internal" });
    expect(err.details).toBeUndefined();
  });

  it("supports cause option (Error#cause round-trip)", () => {
    const cause = new Error("original");
    const err = new EnvdError("wrapped", { code: "internal", cause });
    expect(err.cause).toBe(cause);
  });

  it("survives throw/catch cycle with all fields intact", () => {
    const cause = new TypeError("bad type");
    let caught: unknown;
    try {
      throw new EnvdError("mount failed", {
        code: "mount_failed",
        details: { path: "/Volumes/envd", attempt: 2 },
        cause,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(EnvdError);
    const err = caught as EnvdError;
    expect(err.message).toBe("mount failed");
    expect(err.code).toBe("mount_failed");
    expect(err.details).toEqual({ path: "/Volumes/envd", attempt: 2 });
    expect(err.cause).toBe(cause);
  });

  it("all ErrorCode literals are accepted", () => {
    const codes: ErrorCode[] = [
      "daemon_unreachable",
      "usage_error",
      "provider_unreachable",
      "provider_auth",
      "commit_conflict",
      "mount_failed",
      "not_initialized",
      "internal",
      "bad_dotenv",
      "unauthorized",
    ];
    for (const code of codes) {
      const err = new EnvdError("test", { code });
      expect(err.code).toBe(code);
    }
  });
});
