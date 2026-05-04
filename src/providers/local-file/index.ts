import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  unlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEnvError } from "../../shared/errors.js";
import type {
  ChangeSet,
  Provider,
  ProviderContext,
  ProviderInstance,
  SecretMap,
} from "../base.js";

interface LocalFileConfig {
  readonly path: string;
}

function isLocalFileConfig(config: unknown): config is LocalFileConfig {
  return (
    config !== null &&
    typeof config === "object" &&
    typeof (config as { path?: unknown }).path === "string"
  );
}

function toSecretMap(value: unknown): SecretMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DEnvError("local-file provider file must contain a JSON object", {
      code: "provider_unreachable",
    });
  }

  const map: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") {
      throw new DEnvError(
        "local-file provider file values must all be strings",
        { code: "provider_unreachable" },
      );
    }
    map[key] = raw;
  }

  return map;
}

function readSecretMap(filePath: string): SecretMap {
  try {
    const raw = readFileSync(filePath, "utf-8");
    if (raw.trim() === "") {
      return {};
    }
    return toSecretMap(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new DEnvError("local-file provider cannot read file", {
      code: "provider_unreachable",
      cause: err,
    });
  }
}

function writeAtomic(filePath: string, map: SecretMap): void {
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath) || "secrets"}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const json = JSON.stringify(map, null, 2) + "\n";
  try {
    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
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

function testReadable(
  filePath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    if (raw.trim() !== "") {
      toSecretMap(JSON.parse(raw));
    }
    return Promise.resolve({ ok: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return Promise.resolve({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      accessSync(dirname(filePath), fsConstants.W_OK);
      return Promise.resolve({ ok: true });
    } catch (accessErr: unknown) {
      return Promise.resolve({
        ok: false,
        reason:
          accessErr instanceof Error ? accessErr.message : String(accessErr),
      });
    }
  }
}

function validateConfig(config: unknown): LocalFileConfig {
  if (!isLocalFileConfig(config) || config.path.trim() === "") {
    throw new DEnvError("local-file provider requires config.path", {
      code: "usage_error",
    });
  }
  return config;
}

function instance(
  ctx: ProviderContext,
  config: LocalFileConfig,
): ProviderInstance {
  const filePath = config.path;

  return {
    fetch(): Promise<SecretMap> {
      ctx.logger.debug({
        msg: "local-file fetch",
        data: { pathChars: filePath.length },
      });
      return Promise.resolve().then(() => readSecretMap(filePath));
    },

    push(changes: ChangeSet): Promise<{ status: "ok"; applied: ChangeSet }> {
      return Promise.resolve().then(() => {
        const current = readSecretMap(filePath);
        const next = applyChanges(current, changes);
        writeAtomic(filePath, next);
        return { status: "ok", applied: changes };
      });
    },

    test(): Promise<{ ok: true } | { ok: false; reason: string }> {
      return testReadable(filePath);
    },
  };
}

const localFileProvider: Provider = {
  name: "local-file",
  instanceConfigSchema: {
    type: "object",
    properties: {
      path: { type: "string", title: "JSON file path" },
    },
    required: ["path"],
  },
  credentialKeys: [],
  create(ctx: ProviderContext, config: unknown): Promise<ProviderInstance> {
    return Promise.resolve().then(() => instance(ctx, validateConfig(config)));
  },
};

export default localFileProvider;
