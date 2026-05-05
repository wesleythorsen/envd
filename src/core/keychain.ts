import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createLogger, type Logger } from "../shared/logger.js";
import { stateDir } from "../shared/paths.js";
import { EnvdError } from "../shared/errors.js";
import {
  KEYCHAIN_APPLICATION_NAME,
  SECRET_ENV_VAR,
} from "../shared/product.js";
import type { KeychainAdapter } from "../providers/base.js";

export type { KeychainAdapter };

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  opts?: RunCommandOptions,
) => Promise<CommandResult>;

interface KeychainOptions {
  readonly platform?: NodeJS.Platform;
  readonly logger?: Logger;
  readonly secretsFile?: string;
  readonly runCommand?: CommandRunner;
}

type RandomBytes = (size: number) => Buffer;

const log = createLogger("core/keychain");
const FALLBACK_ALGORITHM = "aes-256-gcm";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(err: unknown): string | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  const code = err["code"];
  return typeof code === "string" ? code : undefined;
}

function defaultSecretsFile(): string {
  return join(stateDir(), "secrets.enc");
}

function mapKey(service: string, account: string): string {
  return `${service}\0${account}`;
}

function stripTrailingCommandNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n") || value.endsWith("\r")) {
    return value.slice(0, -1);
  }
  return value;
}

function commandFailure(
  command: string,
  result: CommandResult,
  message = "keychain command failed",
): EnvdError {
  return new EnvdError(message, {
    code: "internal",
    details: {
      command,
      exitCode: result.code,
      stderr: result.stderr.slice(0, 500),
    },
  });
}

export function spawnCommandRunner(
  command: string,
  args: readonly string[],
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts =
      opts.env === undefined
        ? { stdio: "pipe" as const, windowsHide: true }
        : {
            stdio: "pipe" as const,
            windowsHide: true,
            env: { ...process.env, ...opts.env },
          };
    const child = spawn(command, args, spawnOpts);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    function rejectOnce(err: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", rejectOnce);
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        code: code ?? 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (opts.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(opts.input, "utf8");
    }
  });
}

export class MacOSSecurityKeychainAdapter implements KeychainAdapter {
  private readonly runCommand: CommandRunner;

  constructor(runCommand: CommandRunner = spawnCommandRunner) {
    this.runCommand = runCommand;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const result = await this.runCommand(
      "/bin/sh",
      [
        "-c",
        `exec security add-generic-password "$@" -w "$${SECRET_ENV_VAR}"`,
        `${KEYCHAIN_APPLICATION_NAME}-security`,
        "-s",
        service,
        "-a",
        account,
        "-U",
      ],
      { env: { [SECRET_ENV_VAR]: secret } },
    );
    if (result.code !== 0) {
      throw commandFailure("security", result);
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    const result = await this.runCommand("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    if (result.code === 0) {
      return stripTrailingCommandNewline(result.stdout);
    }
    if (isSecurityNotFound(result)) {
      return null;
    }
    throw commandFailure("security", result);
  }

  async delete(service: string, account: string): Promise<void> {
    const result = await this.runCommand("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
    ]);
    if (result.code === 0 || isSecurityNotFound(result)) {
      return;
    }
    throw commandFailure("security", result);
  }
}

function isSecurityNotFound(result: CommandResult): boolean {
  return (
    result.code === 44 ||
    /could not be found|specified item could not be found/i.test(result.stderr)
  );
}

export class SecretToolKeychainAdapter implements KeychainAdapter {
  private readonly runCommand: CommandRunner;

  constructor(runCommand: CommandRunner = spawnCommandRunner) {
    this.runCommand = runCommand;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const result = await this.runCommand(
      "secret-tool",
      [
        "store",
        "--label",
        `${KEYCHAIN_APPLICATION_NAME} ${service}/${account}`,
        "application",
        KEYCHAIN_APPLICATION_NAME,
        "service",
        service,
        "account",
        account,
      ],
      { input: secret },
    );
    if (result.code !== 0) {
      throw commandFailure("secret-tool", result);
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.lookup(KEYCHAIN_APPLICATION_NAME, service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    await this.clear(KEYCHAIN_APPLICATION_NAME, service, account);
  }

  private async lookup(
    application: string,
    service: string,
    account: string,
  ): Promise<string | null> {
    const result = await this.runCommand("secret-tool", [
      "lookup",
      "application",
      application,
      "service",
      service,
      "account",
      account,
    ]);
    if (result.code === 0) {
      return result.stdout === ""
        ? null
        : stripTrailingCommandNewline(result.stdout);
    }
    if (isSecretToolNotFound(result)) {
      return null;
    }
    throw commandFailure("secret-tool", result);
  }

  private async clear(
    application: string,
    service: string,
    account: string,
  ): Promise<void> {
    const result = await this.runCommand("secret-tool", [
      "clear",
      "application",
      application,
      "service",
      service,
      "account",
      account,
    ]);
    if (result.code === 0 || isSecretToolNotFound(result)) {
      return;
    }
    throw commandFailure("secret-tool", result);
  }
}

function isSecretToolNotFound(result: CommandResult): boolean {
  return (
    result.code === 1 &&
    (result.stderr === "" ||
      /no such|not found|couldn't find/i.test(result.stderr))
  );
}

export class LinuxKeychainAdapter implements KeychainAdapter {
  private readonly logger: Logger;
  private readonly runCommand: CommandRunner;
  private readonly secretsFile: string;
  private readonly fallbackRandomBytes: RandomBytes;
  private delegatePromise: Promise<KeychainAdapter> | undefined;

  constructor(opts: KeychainOptions = {}) {
    this.logger = opts.logger ?? log;
    this.runCommand = opts.runCommand ?? spawnCommandRunner;
    this.secretsFile = opts.secretsFile ?? defaultSecretsFile();
    this.fallbackRandomBytes = nodeRandomBytes;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const delegate = await this.delegate();
    await delegate.set(service, account, secret);
  }

  async get(service: string, account: string): Promise<string | null> {
    const delegate = await this.delegate();
    return delegate.get(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    const delegate = await this.delegate();
    await delegate.delete(service, account);
  }

  private delegate(): Promise<KeychainAdapter> {
    this.delegatePromise ??= this.resolveDelegate();
    return this.delegatePromise;
  }

  private async resolveDelegate(): Promise<KeychainAdapter> {
    try {
      const result = await this.runCommand("secret-tool", ["--version"]);
      if (result.code === 0) {
        return new SecretToolKeychainAdapter(this.runCommand);
      }
      this.logger.warn({
        msg: "secret-tool is unavailable; using encrypted file keychain fallback",
        data: { exitCode: result.code },
      });
    } catch (err: unknown) {
      if (errorCode(err) !== "ENOENT") {
        throw err;
      }
      this.logger.warn({
        msg: "secret-tool is not installed; using encrypted file keychain fallback",
      });
    }
    return new EncryptedFileKeychainAdapter({
      logger: this.logger,
      secretsFile: this.secretsFile,
      randomBytes: this.fallbackRandomBytes,
    });
  }
}

interface EncryptedFileKeychainOptions {
  readonly logger?: Logger;
  readonly secretsFile?: string;
  readonly randomBytes?: RandomBytes;
}

interface EncryptedPayload {
  readonly version: 1;
  readonly algorithm: typeof FALLBACK_ALGORITHM;
  readonly nonce: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

export class EncryptedFileKeychainAdapter implements KeychainAdapter {
  private readonly logger: Logger;
  private readonly secretsFile: string;
  private readonly randomBytes: RandomBytes;
  private readonly key: Buffer;
  private reportedReadFailure = false;

  constructor(opts: EncryptedFileKeychainOptions = {}) {
    this.logger = opts.logger ?? log;
    this.secretsFile = opts.secretsFile ?? defaultSecretsFile();
    this.randomBytes = opts.randomBytes ?? nodeRandomBytes;
    this.key = this.randomBytes(32);
    this.logger.warn({
      msg: "Using encrypted file keychain fallback; fallback key is memory-only, so credentials must be re-entered after daemon restart",
      data: { path: this.secretsFile },
    });
  }

  set(service: string, account: string, secret: string): Promise<void> {
    const store = this.readStore();
    store.set(mapKey(service, account), secret);
    this.writeStore(store);
    return Promise.resolve();
  }

  get(service: string, account: string): Promise<string | null> {
    return Promise.resolve(
      this.readStore().get(mapKey(service, account)) ?? null,
    );
  }

  delete(service: string, account: string): Promise<void> {
    const store = this.readStore();
    store.delete(mapKey(service, account));
    this.writeStore(store);
    return Promise.resolve();
  }

  private readStore(): Map<string, string> {
    let raw: string;
    try {
      raw = readFileSync(this.secretsFile, "utf8");
    } catch (err: unknown) {
      if (errorCode(err) === "ENOENT") {
        return new Map<string, string>();
      }
      throw err;
    }

    try {
      const payload = parseEncryptedPayload(JSON.parse(raw));
      const nonce = Buffer.from(payload.nonce, "base64");
      const authTag = Buffer.from(payload.authTag, "base64");
      const ciphertext = Buffer.from(payload.ciphertext, "base64");
      const decipher = createDecipheriv(FALLBACK_ALGORITHM, this.key, nonce);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      return parseStore(JSON.parse(plaintext));
    } catch (err: unknown) {
      if (!this.reportedReadFailure) {
        this.reportedReadFailure = true;
        this.logger.warn({
          msg: "Encrypted file keychain fallback could not read existing secrets; the memory-only fallback key does not survive daemon restarts",
          data: { path: this.secretsFile, error: String(err) },
        });
      }
      return new Map<string, string>();
    }
  }

  private writeStore(store: Map<string, string>): void {
    mkdirSync(dirname(this.secretsFile), { recursive: true });
    if (store.size === 0) {
      rmSync(this.secretsFile, { force: true });
      return;
    }

    const plaintext = JSON.stringify(Object.fromEntries(store));
    const nonce = this.randomBytes(12);
    const cipher = createCipheriv(FALLBACK_ALGORITHM, this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const payload: EncryptedPayload = {
      version: 1,
      algorithm: FALLBACK_ALGORITHM,
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const tmpPath = `${this.secretsFile}.${process.pid}.${this.randomBytes(
      6,
    ).toString("hex")}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, this.secretsFile);
  }
}

function parseEncryptedPayload(value: unknown): EncryptedPayload {
  if (!isRecord(value)) {
    throw new Error("encrypted keychain payload must be an object");
  }
  const version = value["version"];
  const algorithm = value["algorithm"];
  const nonce = value["nonce"];
  const authTag = value["authTag"];
  const ciphertext = value["ciphertext"];
  if (
    version !== 1 ||
    algorithm !== FALLBACK_ALGORITHM ||
    typeof nonce !== "string" ||
    typeof authTag !== "string" ||
    typeof ciphertext !== "string"
  ) {
    throw new Error("encrypted keychain payload has an unsupported shape");
  }
  return { version, algorithm, nonce, authTag, ciphertext };
}

function parseStore(value: unknown): Map<string, string> {
  if (!isRecord(value)) {
    throw new Error("encrypted keychain store must be an object");
  }
  const store = new Map<string, string>();
  for (const [key, secret] of Object.entries(value)) {
    if (typeof secret !== "string") {
      throw new Error("encrypted keychain store contains a non-string value");
    }
    store.set(key, secret);
  }
  return store;
}

export function createKeychainAdapter(
  opts: KeychainOptions = {},
): KeychainAdapter {
  const platform = opts.platform ?? process.platform;
  switch (platform) {
    case "darwin":
      return new MacOSSecurityKeychainAdapter(
        opts.runCommand ?? spawnCommandRunner,
      );
    case "linux":
      return new LinuxKeychainAdapter(opts);
    default:
      throw new EnvdError(
        "keychain adapter is not supported on this platform",
        {
          code: "internal",
          details: { platform },
        },
      );
  }
}
