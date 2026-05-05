import { DEnvError } from "../../shared/errors.js";
import type {
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
    throw new DEnvError("doppler provider config must be a JSON object", {
      code: "usage_error",
    });
  }

  const project = config["project"];
  if (typeof project !== "string" || project.trim() === "") {
    throw new DEnvError("doppler provider requires config.project", {
      code: "usage_error",
    });
  }

  const dopplerConfig = config["config"];
  if (typeof dopplerConfig !== "string" || dopplerConfig.trim() === "") {
    throw new DEnvError("doppler provider requires config.config", {
      code: "usage_error",
    });
  }

  const apiHost = config["apiHost"];
  if (apiHost !== undefined && typeof apiHost !== "string") {
    throw new DEnvError("doppler provider config.apiHost must be a string", {
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
      throw new DEnvError("doppler provider config.apiHost must be non-empty", {
        code: "usage_error",
      });
    }

    try {
      new URL(trimmedApiHost);
    } catch (err: unknown) {
      throw new DEnvError("doppler provider config.apiHost must be a URL", {
        code: "usage_error",
        cause: err,
      });
    }
    return { ...validated, apiHost: trimmedApiHost };
  }

  return validated;
}

function secretsUrl(config: DopplerConfig): URL {
  const url = new URL(
    "/v3/configs/config/secrets/download",
    config.apiHost ?? DEFAULT_API_HOST,
  );
  url.searchParams.set("format", "json");
  url.searchParams.set("project", config.project);
  url.searchParams.set("config", config.config);
  return url;
}

function statusDetails(response: Response): Record<string, unknown> {
  return { provider: PROVIDER_NAME, statusCode: response.status };
}

function httpError(response: Response): DEnvError {
  if (response.status === 401 || response.status === 403) {
    return new DEnvError("doppler provider authentication failed", {
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
    return new DEnvError("doppler provider rate limit exceeded", {
      code: "provider_unreachable",
      details,
    });
  }

  return new DEnvError("doppler provider request failed", {
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
    throw new DEnvError("doppler provider returned invalid JSON", {
      code: "provider_unreachable",
      details: { provider: PROVIDER_NAME },
      cause: err,
    });
  }
}

async function apiToken(ctx: ProviderContext): Promise<string> {
  const token = await ctx.keychain.get(PROVIDER_NAME, API_TOKEN_KEY);
  if (token === null || token.trim() === "") {
    throw new DEnvError("doppler provider requires apiToken", {
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
    response = await ctx.fetch(secretsUrl(config), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err: unknown) {
    throw new DEnvError("doppler provider is unreachable", {
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
    throw new DEnvError("doppler provider response could not be read", {
      code: "provider_unreachable",
      details: { provider: PROVIDER_NAME },
      cause: err,
    });
  }

  return parseSecretMap(raw);
}

function instance(
  ctx: ProviderContext,
  config: DopplerConfig,
): ProviderInstance {
  return {
    fetch(): Promise<SecretMap> {
      return fetchSecrets(ctx, config);
    },

    push(): Promise<PushResult> {
      return Promise.reject(
        new DEnvError("doppler provider push is not implemented", {
          code: "usage_error",
        }),
      );
    },

    async test(): Promise<{ ok: true } | { ok: false; reason: string }> {
      try {
        await fetchSecrets(ctx, config);
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

const dopplerProvider: Provider = {
  name: PROVIDER_NAME,
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
