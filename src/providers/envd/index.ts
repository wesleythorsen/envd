import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateDir } from "../../shared/paths.js";
import { EnvdError } from "../../shared/errors.js";
import type {
  ChangeSet,
  Provider,
  ProviderContext,
  ProviderInstance,
  SecretMap,
} from "../base.js";

const ENCRYPTION_KEY_ACCOUNT = "local-store-encryption-key";

interface EnvdProviderConfig {
  readonly root?: string;
}

interface EncryptedPayload {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(config: unknown): Required<EnvdProviderConfig> {
  if (!isRecord(config)) {
    throw new EnvdError("envd provider config must be an object", {
      code: "usage_error",
    });
  }
  const root = config["root"];
  if (root !== undefined && (typeof root !== "string" || root.trim() === "")) {
    throw new EnvdError(
      "envd provider config.root must be a non-empty string",
      {
        code: "usage_error",
      },
    );
  }
  return { root: root ?? join(stateDir(), "providers", "envd") };
}

function encodePathSegment(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function storePath(
  config: Required<EnvdProviderConfig>,
  projectId: string,
  environment: string,
): string {
  return join(
    config.root,
    encodePathSegment(projectId),
    `${encodePathSegment(environment)}.json.enc`,
  );
}

function toSecretMap(value: unknown): SecretMap {
  if (!isRecord(value)) {
    throw new Error("envd provider payload must contain an object");
  }
  const map: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new Error("envd provider payload values must be strings");
    }
    map[key] = raw;
  }
  return map;
}

function parseEncryptedPayload(value: unknown): EncryptedPayload {
  if (!isRecord(value)) {
    throw new Error("encrypted envd provider payload must be an object");
  }
  const version = value["version"];
  const algorithm = value["algorithm"];
  const iv = value["iv"];
  const authTag = value["authTag"];
  const ciphertext = value["ciphertext"];
  if (
    version !== 1 ||
    algorithm !== "aes-256-gcm" ||
    typeof iv !== "string" ||
    typeof authTag !== "string" ||
    typeof ciphertext !== "string"
  ) {
    throw new Error("encrypted envd provider payload has an unsupported shape");
  }
  return { version, algorithm, iv, authTag, ciphertext };
}

async function loadOrCreateKey(ctx: ProviderContext): Promise<Buffer> {
  const existing = await ctx.keychain.get("envd", ENCRYPTION_KEY_ACCOUNT);
  if (existing !== null) {
    const key = Buffer.from(existing, "base64");
    if (key.length !== 32) {
      throw new EnvdError("envd provider encryption key is invalid", {
        code: "provider_unreachable",
      });
    }
    return key;
  }

  const key = nodeRandomBytes(32);
  await ctx.keychain.set(
    "envd",
    ENCRYPTION_KEY_ACCOUNT,
    key.toString("base64"),
  );
  return key;
}

function encrypted(map: SecretMap, key: Buffer): string {
  const iv = nodeRandomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(map), "utf8"),
    cipher.final(),
  ]);
  const payload: EncryptedPayload = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function decrypted(raw: string, key: Buffer): SecretMap {
  const payload = parseEncryptedPayload(JSON.parse(raw) as unknown);
  const decipher = createDecipheriv(
    payload.algorithm,
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return toSecretMap(JSON.parse(plaintext) as unknown);
}

function readSecretMap(path: string, key: Buffer): SecretMap {
  try {
    return decrypted(readFileSync(path, "utf-8"), key);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new EnvdError("envd provider cannot read encrypted store", {
      code: "provider_unreachable",
      cause: err,
    });
  }
}

function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(
    dirname(path),
    `.${basename(path)}.${nodeRandomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmpPath, body, "utf-8");
    renameSync(tmpPath, path);
  } catch (err: unknown) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

function applyChanges(remote: SecretMap, changes: ChangeSet): SecretMap {
  const merged: Record<string, string> = { ...remote };
  for (const key of changes.deletes) {
    delete merged[key];
  }
  for (const [key, value] of Object.entries(changes.upserts)) {
    merged[key] = value;
  }
  return merged;
}

function requireScope(ctx: ProviderContext): {
  readonly projectId: string;
  readonly environment: string;
} {
  if (ctx.projectId === undefined || ctx.environment === undefined) {
    throw new EnvdError(
      "envd provider requires project and environment context",
      { code: "usage_error" },
    );
  }
  return { projectId: ctx.projectId, environment: ctx.environment };
}

function instance(
  ctx: ProviderContext,
  config: Required<EnvdProviderConfig>,
): ProviderInstance {
  return {
    async fetch(): Promise<SecretMap> {
      const scope = requireScope(ctx);
      const key = await loadOrCreateKey(ctx);
      return readSecretMap(
        storePath(config, scope.projectId, scope.environment),
        key,
      );
    },

    async push(
      changes: ChangeSet,
    ): Promise<{ readonly status: "ok"; readonly applied: ChangeSet }> {
      const scope = requireScope(ctx);
      const key = await loadOrCreateKey(ctx);
      const path = storePath(config, scope.projectId, scope.environment);
      const current = readSecretMap(path, key);
      writeAtomic(path, encrypted(applyChanges(current, changes), key));
      return { status: "ok", applied: changes };
    },

    async test(): Promise<{ ok: true } | { ok: false; reason: string }> {
      try {
        mkdirSync(config.root, { recursive: true });
        await loadOrCreateKey(ctx);
        return { ok: true };
      } catch (err: unknown) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

const envdProvider: Provider = {
  name: "envd",
  environmentMode: "native",
  instanceConfigSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        title: "Store root",
        description: "Directory for envd-managed encrypted local secrets",
      },
    },
  },
  credentialKeys: [],
  create(ctx: ProviderContext, config: unknown): Promise<ProviderInstance> {
    return Promise.resolve(instance(ctx, validateConfig(config)));
  },
};

export default envdProvider;
