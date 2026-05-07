import { EnvdError } from "../../shared/errors.js";
import type {
  ChangeSet,
  Provider,
  ProviderContext,
  ProviderInstance,
  PushResult,
  SecretMap,
} from "../base.js";

interface DopplerConfig {
  readonly project: string;
  readonly config: string;
  readonly apiHost?: string;
}

const DEFAULT_API_HOST = "https://api.doppler.com";
const PROVIDER_NAME = "doppler";
const API_TOKEN_KEY = "apiToken";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(config: unknown): DopplerConfig {
  if (!isRecord(config)) {
    throw new EnvdError("doppler provider config must be a JSON object", {
      code: "usage_error",
    });
  }

  const project = config["project"];
  if (typeof project !== "string" || project.trim() === "") {
    throw new EnvdError("doppler provider requires config.project", {
      code: "usage_error",
    });
  }

  const dopplerConfig = config["config"];
  if (typeof dopplerConfig !== "string" || dopplerConfig.trim() === "") {
    throw new EnvdError("doppler provider requires config.config", {
      code: "usage_error",
    });
  }

  const apiHost = config["apiHost"];
  if (apiHost !== undefined && typeof apiHost !== "string") {
    throw new EnvdError("doppler provider config.apiHost must be a string", {
      code: "usage_error",
    });
  }

  const validated: DopplerConfig = {
    project: project.trim(),
    config: dopplerConfig.trim(),
  };

  if (apiHost !== undefined) {
    const trimmedApiHost = apiHost.trim();
    if (trimmedApiHost === "") {
      throw new EnvdError("doppler provider config.apiHost must be non-empty", {
        code: "usage_error",
      });
    }

    try {
      new URL(trimmedApiHost);
    } catch (err: unknown) {
      throw new EnvdError("doppler provider config.apiHost must be a URL", {
        code: "usage_error",
        cause: err,
      });
    }
    return { ...validated, apiHost: trimmedApiHost };
  }

  return validated;
}

function downloadSecretsUrl(config: DopplerConfig): URL {
  const url = new URL(
    "/v3/configs/config/secrets/download",
    config.apiHost ?? DEFAULT_API_HOST,
  );
  url.searchParams.set("format", "json");
  url.searchParams.set("project", config.project);
  url.searchParams.set("config", config.config);
  return url;
}

function updateSecretsUrl(config: DopplerConfig): URL {
  return new URL(
    "/v3/configs/config/secrets",
    config.apiHost ?? DEFAULT_API_HOST,
  );
}

function deleteSecretUrl(config: DopplerConfig, name: string): URL {
  const url = new URL(
    "/v3/configs/config/secret",
    config.apiHost ?? DEFAULT_API_HOST,
  );
  url.searchParams.set("project", config.project);
  url.searchParams.set("config", config.config);
  url.searchParams.set("name", name);
  return url;
}

function meUrl(config: DopplerConfig): URL {
  return new URL("/v3/me", config.apiHost ?? DEFAULT_API_HOST);
}

function statusDetails(response: Response): Record<string, unknown> {
  return { provider: PROVIDER_NAME, statusCode: response.status };
}

function httpError(response: Response): EnvdError {
  if (response.status === 401 || response.status === 403) {
    return new EnvdError("doppler provider authentication failed", {
      code: "provider_auth",
      details: statusDetails(response),
    });
  }

  if (response.status === 429) {
    const details = statusDetails(response);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) {
      details["retryAfter"] = retryAfter;
    }
    return new EnvdError("doppler provider rate limit exceeded", {
      code: "provider_unreachable",
      details,
    });
  }

  return new EnvdError("doppler provider request failed", {
    code: "provider_unreachable",
    details: statusDetails(response),
  });
}

function toSecretMap(value: unknown): SecretMap {
  if (!isRecord(value)) {
    throw new TypeError("doppler response must be a JSON object");
  }

  const map: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      throw new TypeError("doppler response values must all be strings");
    }
    map[key] = raw;
  }
  return map;
}

function parseSecretMap(raw: string): SecretMap {
  try {
    return toSecretMap(JSON.parse(raw) as unknown);
  } catch (err: unknown) {
    throw new EnvdError("doppler provider returned invalid JSON", {
      code: "provider_unreachable",
      details: { provider: PROVIDER_NAME },
      cause: err,
    });
  }
}

async function apiToken(ctx: ProviderContext): Promise<string> {
  const token = await ctx.keychain.get(PROVIDER_NAME, API_TOKEN_KEY);
  if (token === null || token.trim() === "") {
    throw new EnvdError("doppler provider requires apiToken", {
      code: "provider_auth",
      details: { provider: PROVIDER_NAME, credential: API_TOKEN_KEY },
    });
  }
  return token;
}

async function fetchSecrets(
  ctx: ProviderContext,
  config: DopplerConfig,
): Promise<SecretMap> {
  ctx.logger.debug({
    msg: "doppler fetch",
    data: { project: config.project, config: config.config },
  });

  const token = await apiToken(ctx);
  let response: Response;
  try {
    response = await ctx.fetch(downloadSecretsUrl(config), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err: unknown) {
    throw new EnvdError("doppler provider is unreachable", {
      code: "provider_unreachable",
      details: { provider: PROVIDER_NAME },
      cause: err,
    });
  }

  if (!response.ok) {
    throw httpError(response);
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (err: unknown) {
    throw new EnvdError("doppler provider response could not be read", {
      code: "provider_unreachable",
      details: { provider: PROVIDER_NAME },
      cause: err,
    });
  }

  return parseSecretMap(raw);
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function testAuth(
  ctx: ProviderContext,
  config: DopplerConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  ctx.logger.debug({
    msg: "doppler test",
    data: { apiHost: config.apiHost ?? DEFAULT_API_HOST },
  });

  try {
    const token = await apiToken(ctx);
    let response: Response;
    try {
      response = await ctx.fetch(meUrl(config), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err: unknown) {
      throw new EnvdError("doppler provider is unreachable", {
        code: "provider_unreachable",
        details: { provider: PROVIDER_NAME },
        cause: err,
      });
    }

    if (!response.ok) {
      throw httpError(response);
    }

    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, reason: errorReason(err) };
  }
}

async function updateSecrets(
  ctx: ProviderContext,
  config: DopplerConfig,
  token: string,
  upserts: Record<string, string>,
): Promise<void> {
  let response: Response;
  try {
    response = await ctx.fetch(updateSecretsUrl(config), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project: config.project,
        config: config.config,
        secrets: upserts,
      }),
    });
  } catch (err: unknown) {
    throw new EnvdError("doppler provider is unreachable", {
      code: "provider_unreachable",
      details: { provider: PROVIDER_NAME },
      cause: err,
    });
  }

  if (!response.ok) {
    throw httpError(response);
  }
}

async function deleteSecret(
  ctx: ProviderContext,
  config: DopplerConfig,
  token: string,
  name: string,
): Promise<void> {
  let response: Response;
  try {
    response = await ctx.fetch(deleteSecretUrl(config, name), {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err: unknown) {
    throw new EnvdError("doppler provider is unreachable", {
      code: "provider_unreachable",
      details: { provider: PROVIDER_NAME },
      cause: err,
    });
  }

  if (response.status === 404) {
    return;
  }

  if (!response.ok) {
    throw httpError(response);
  }
}

function deleteNames(changes: ChangeSet): string[] {
  const upsertKeys = new Set(Object.keys(changes.upserts));
  const deletes = new Set<string>();
  for (const name of changes.deletes) {
    if (!upsertKeys.has(name)) {
      deletes.add(name);
    }
  }
  return [...deletes];
}

function changesApplied(remote: SecretMap, changes: ChangeSet): boolean {
  for (const [key, value] of Object.entries(changes.upserts)) {
    if (remote[key] !== value) {
      return false;
    }
  }

  const upsertKeys = new Set(Object.keys(changes.upserts));
  for (const key of changes.deletes) {
    if (
      !upsertKeys.has(key) &&
      Object.prototype.hasOwnProperty.call(remote, key)
    ) {
      return false;
    }
  }

  return true;
}

async function pushSecrets(
  ctx: ProviderContext,
  config: DopplerConfig,
  changes: ChangeSet,
): Promise<PushResult> {
  ctx.logger.debug({
    msg: "doppler push",
    data: {
      project: config.project,
      config: config.config,
      upserts: Object.keys(changes.upserts).length,
      deletes: changes.deletes.length,
    },
  });

  const token = await apiToken(ctx);
  let appliedAny = false;

  try {
    if (Object.keys(changes.upserts).length > 0) {
      await updateSecrets(ctx, config, token, changes.upserts);
      appliedAny = true;
    }

    for (const name of deleteNames(changes)) {
      await deleteSecret(ctx, config, token, name);
      appliedAny = true;
    }
  } catch (err: unknown) {
    if (appliedAny) {
      return { status: "conflict", remote: await fetchSecrets(ctx, config) };
    }
    throw err;
  }

  const remote = await fetchSecrets(ctx, config);
  if (!changesApplied(remote, changes)) {
    return { status: "conflict", remote };
  }

  return { status: "ok", applied: changes };
}

function instance(
  ctx: ProviderContext,
  config: DopplerConfig,
): ProviderInstance {
  return {
    fetch(): Promise<SecretMap> {
      return fetchSecrets(ctx, config);
    },

    push(changes: ChangeSet): Promise<PushResult> {
      return pushSecrets(ctx, config, changes);
    },

    async test(): Promise<{ ok: true } | { ok: false; reason: string }> {
      return testAuth(ctx, config);
    },
  };
}

const dopplerProvider: Provider = {
  name: PROVIDER_NAME,
  environmentMode: "config-adapter",
  instanceConfigSchema: {
    type: "object",
    properties: {
      project: { type: "string", title: "Doppler project" },
      config: { type: "string", title: "Doppler config" },
      apiHost: {
        type: "string",
        title: "Doppler API host",
        default: DEFAULT_API_HOST,
      },
    },
    required: ["project", "config"],
  },
  credentialKeys: [API_TOKEN_KEY],
  create(ctx: ProviderContext, config: unknown): Promise<ProviderInstance> {
    return Promise.resolve().then(() => instance(ctx, validateConfig(config)));
  },
};

export default dopplerProvider;
