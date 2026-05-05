import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliError, writeCliError } from "../../src/cli/error-output.js";
import { EnvdError, ERROR_CODES } from "../../src/shared/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatCliError", () => {
  it("tracks the full ErrorCode enum", () => {
    expect(ERROR_CODES).toEqual([
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
      "not_found",
      "method_not_allowed",
    ]);
  });

  it("formats daemon_unreachable with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example daemon_unreachable", {
          code: "daemon_unreachable",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example daemon_unreachable
      Try: start the daemon with \`envd daemon start\` or inspect \`envd daemon status\`, then rerun the command."
    `);
  });

  it("formats usage_error with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example usage_error", {
          code: "usage_error",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example usage_error
      Try: rerun the command with \`--help\` to confirm the required flags and arguments."
    `);
  });

  it("formats provider_unreachable with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example provider_unreachable", {
          code: "provider_unreachable",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example provider_unreachable
      Try: run \`envd provider test <id>\` and verify the provider host, network access, or service limits."
    `);
  });

  it("formats provider_auth with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example provider_auth", {
          code: "provider_auth",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example provider_auth
      Try: update the provider credentials, then rerun \`envd provider test <id>\`."
    `);
  });

  it("formats commit_conflict with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example commit_conflict", {
          code: "commit_conflict",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example commit_conflict
      Try: rerun with \`envd commit --ours\` to keep local values or \`envd commit --theirs\` to accept remote values."
    `);
  });

  it("formats mount_failed with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example mount_failed", {
          code: "mount_failed",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example mount_failed
      Try: run \`envd status\` to inspect the mount, then restart the daemon and relink the project."
    `);
  });

  it("formats not_initialized with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example not_initialized", {
          code: "not_initialized",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example not_initialized
      Try: run \`envd init\` in this project directory before retrying the command."
    `);
  });

  it("formats internal with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example internal", {
          code: "internal",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example internal
      Try: rerun the command, then inspect \`envd daemon logs --tail 100\` if the problem persists."
    `);
  });

  it("formats bad_dotenv with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example bad_dotenv", {
          code: "bad_dotenv",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example bad_dotenv
      Try: fix the .env syntax and rerun the command, or inspect the rendered output with \`envd diff --values\`."
    `);
  });

  it("formats unauthorized with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example unauthorized", {
          code: "unauthorized",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example unauthorized
      Try: restart the daemon to refresh local auth state, then rerun the command."
    `);
  });

  it("formats not_found with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example not_found", {
          code: "not_found",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example not_found
      Try: verify the project path, project id, or provider instance id and rerun the command."
    `);
  });

  it("formats method_not_allowed with an actionable hint", () => {
    expect(
      formatCliError(
        new EnvdError("example method_not_allowed", {
          code: "method_not_allowed",
        }),
      ),
    ).toMatchInlineSnapshot(`
      "example method_not_allowed
      Try: upgrade the CLI and daemon together so both sides support the same command."
    `);
  });

  it("falls back to raw Error messages for non-Envd errors", () => {
    expect(formatCliError(new Error("plain error"))).toBe("plain error");
  });

  it("falls back to string conversion for non-error values", () => {
    expect(formatCliError(42)).toBe("42");
  });
});

describe("writeCliError", () => {
  it("writes the formatted message to stderr and exits 1", () => {
    let stderr = "";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });

    expect(() =>
      writeCliError(
        new EnvdError("project is not initialized", {
          code: "not_initialized",
        }),
        {
          stderr: {
            write(chunk: string) {
              stderr += chunk;
              return true;
            },
          },
        },
      ),
    ).toThrow("process.exit:1");

    exitSpy.mockRestore();
    expect(stderr).toBe(
      "project is not initialized\n" +
        "Try: run `envd init` in this project directory before retrying the command.\n",
    );
  });
});
