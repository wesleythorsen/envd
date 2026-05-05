import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EncryptedFileKeychainAdapter,
  LinuxKeychainAdapter,
  MacOSSecurityKeychainAdapter,
  SecretToolKeychainAdapter,
  type CommandResult,
  type CommandRunner,
} from "../../src/core/keychain.js";
import type { Logger } from "../../src/shared/logger.js";

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
  input?: string;
  env?: Readonly<Record<string, string>>;
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(code: number, stderr = ""): CommandResult {
  return { code, stdout: "", stderr };
}

function missingExecutable(): Error & { code: string } {
  return Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
}

function fakeRunner(results: Array<CommandResult | Error>): {
  readonly calls: CommandCall[];
  readonly runner: CommandRunner;
} {
  const calls: CommandCall[] = [];
  const runner: CommandRunner = (command, args, opts) => {
    const call: CommandCall = { command, args: [...args] };
    if (opts?.input !== undefined) {
      call.input = opts.input;
    }
    if (opts?.env !== undefined) {
      call.env = opts.env;
    }
    calls.push(call);
    const next = results.shift();
    if (next === undefined) {
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  };
  return { calls, runner };
}

describe("MacOSSecurityKeychainAdapter", () => {
  it("stores credentials with security using an env-var shell wrapper", async () => {
    const { calls, runner } = fakeRunner([ok()]);
    const adapter = new MacOSSecurityKeychainAdapter(runner);

    await adapter.set("provider-instance", "apiToken", "secret-value");

    expect(calls).toEqual([
      {
        command: "/bin/sh",
        args: [
          "-c",
          'exec security add-generic-password "$@" -w "$D_ENV_SECRET"',
          "d-env-security",
          "-s",
          "provider-instance",
          "-a",
          "apiToken",
          "-U",
        ],
        env: { D_ENV_SECRET: "secret-value" },
      },
    ]);
    expect(calls[0]?.args).not.toContain("secret-value");
    expect(calls[0]?.input).toBeUndefined();
  });

  it("reads and deletes credentials through security", async () => {
    const { runner } = fakeRunner([
      ok("secret-value\n"),
      fail(44, "The specified item could not be found in the keychain."),
      fail(44, "The specified item could not be found in the keychain."),
    ]);
    const adapter = new MacOSSecurityKeychainAdapter(runner);

    await expect(adapter.get("svc", "acct")).resolves.toBe("secret-value");
    await expect(adapter.get("svc", "missing")).resolves.toBeNull();
    await expect(adapter.delete("svc", "missing")).resolves.toBeUndefined();
  });
});

describe("SecretToolKeychainAdapter", () => {
  it("stores, reads, and clears credentials through secret-tool", async () => {
    const { calls, runner } = fakeRunner([ok(), ok("secret-value\n"), ok()]);
    const adapter = new SecretToolKeychainAdapter(runner);

    await adapter.set("svc", "acct", "secret-value");
    await expect(adapter.get("svc", "acct")).resolves.toBe("secret-value");
    await expect(adapter.delete("svc", "acct")).resolves.toBeUndefined();

    expect(calls[0]).toEqual({
      command: "secret-tool",
      args: [
        "store",
        "--label",
        "d-env svc/acct",
        "application",
        "d-env",
        "service",
        "svc",
        "account",
        "acct",
      ],
      input: "secret-value",
    });
    expect(calls[0]?.args).not.toContain("secret-value");
    expect(calls[1]?.args[0]).toBe("lookup");
    expect(calls[2]?.args[0]).toBe("clear");
  });

  it("returns null for missing secret-tool credentials", async () => {
    const { runner } = fakeRunner([fail(1)]);
    const adapter = new SecretToolKeychainAdapter(runner);

    await expect(adapter.get("svc", "missing")).resolves.toBeNull();
  });
});

describe("LinuxKeychainAdapter", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("uses secret-tool when it is available", async () => {
    const { calls, runner } = fakeRunner([
      ok("secret-tool 0.21.4\n"),
      ok(),
      ok("secret-value\n"),
    ]);
    const adapter = new LinuxKeychainAdapter({
      logger: silentLogger,
      runCommand: runner,
    });

    await adapter.set("svc", "acct", "secret-value");
    await expect(adapter.get("svc", "acct")).resolves.toBe("secret-value");

    expect(calls.map((call) => call.args[0])).toEqual([
      "--version",
      "store",
      "lookup",
    ]);
  });

  it("falls back to an encrypted file when secret-tool is missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-keychain-"));
    const secretsFile = join(tempDir, "secrets.enc");
    const { calls, runner } = fakeRunner([missingExecutable()]);
    const adapter = new LinuxKeychainAdapter({
      logger: silentLogger,
      runCommand: runner,
      secretsFile,
    });

    await adapter.set("svc", "acct", "secret-value");
    await expect(adapter.get("svc", "acct")).resolves.toBe("secret-value");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("secret-tool");
    expect(readFileSync(secretsFile, "utf8")).not.toContain("secret-value");

    await adapter.delete("svc", "acct");
    expect(existsSync(secretsFile)).toBe(false);
  });
});

describe("EncryptedFileKeychainAdapter", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("documents the memory-only key limitation by not reading another daemon key", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-keychain-"));
    const secretsFile = join(tempDir, "secrets.enc");
    const firstDaemon = new EncryptedFileKeychainAdapter({
      logger: silentLogger,
      secretsFile,
    });
    await firstDaemon.set("svc", "acct", "secret-value");

    const nextDaemon = new EncryptedFileKeychainAdapter({
      logger: silentLogger,
      secretsFile,
    });

    await expect(nextDaemon.get("svc", "acct")).resolves.toBeNull();
    await expect(firstDaemon.get("svc", "acct")).resolves.toBe("secret-value");
  });
});
