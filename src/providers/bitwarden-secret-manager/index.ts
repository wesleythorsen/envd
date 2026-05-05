import { BitwardenClient } from "@bitwarden/sdk-napi";
import { DEnvError } from "../../shared/errors.js";
import type {
  ChangeSet,
  Provider,
  ProviderContext,
  ProviderInstance,
  PushResult,
  SecretMap,
} from "../base.js";

interface BitwardenConfig {
  readonly projectId: string;
  readonly apiUrl?: string;
}

interface BitwardenProject {
  readonly id: string;
  readonly organizationId: string;
}

interface BitwardenSecret {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly projectId: string | null | undefined;
}

interface BitwardenSession {
  readonly client: BitwardenClient;
  readonly project: BitwardenProject;
}

const PROVIDER_NAME = "bitwarden-secret-manager";
const ACCESS_TOKEN_KEY = "accessToken";
const DEFAULT_API_URL = "https://api.bitwarden.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(config: unknown): BitwardenConfig {
  if (!isRecord(config)) {
    throw new DEnvError(
      "bitwarden-secret-manager provider config must be a JSON object",
      {
        code: "usage_error",
      },
    );
  }

  const projectId = config["projectId"];
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new DEnvError(
      "bitwarden-secret-manager provider requires config.projectId",
      {
        code: "usage_error",
      },
    );
  }

  const apiUrl = config["apiUrl"];
  if (apiUrl !== undefined && typeof apiUrl !== "string") {
    throw new DEnvError(
      "bitwarden-secret-manager provider config.apiUrl must be a string",
      {
        code: "usage_error",
      },
    );
  }

  const trimmedProjectId = projectId.trim();
  if (apiUrl === undefined) {
    return { projectId: trimmedProjectId };
  }

  const trimmedApiUrl = apiUrl.trim();
  if (trimmedApiUrl === "") {
    throw new DEnvError(
      "bitwarden-secret-manager provider config.apiUrl must be non-empty",
      {
        code: "usage_error",
      },
    );
  }

  try {
    new URL(trimmedApiUrl);
  } catch (err: unknown) {
    throw new DEnvError(
      "bitwarden-secret-manager provider config.apiUrl must be a URL",
      {
        code: "usage_error",
        cause: err,
      },
    );
  }

  return {
    projectId: trimmedProjectId,
    apiUrl: trimmedApiUrl,
  };
}

function deriveIdentityUrl(apiUrl: string): string {
  const identity = new URL(apiUrl);

  if (identity.hostname.startsWith("api.")) {
    identity.hostname = `identity.${identity.hostname.slice(4)}`;
    if (identity.pathname === "/") {
      identity.pathname = "/";
    }
    return identity.toString();
  }

  identity.pathname = identity.pathname.replace(/\/?$/, "/identity");
  return identity.toString();
}

async function accessToken(ctx: ProviderContext): Promise<string> {
  const token = await ctx.keychain.get(PROVIDER_NAME, ACCESS_TOKEN_KEY);
  if (token === null || token.trim() === "") {
    throw new DEnvError(
      "bitwarden-secret-manager provider requires accessToken",
      {
        code: "provider_auth",
        details: { provider: PROVIDER_NAME, credential: ACCESS_TOKEN_KEY },
      },
    );
  }
  return token;
}

function sdkSettings(config: BitwardenConfig) {
  if (config.apiUrl === undefined) {
    return undefined;
  }
  return {
    apiUrl: config.apiUrl,
    identityUrl: deriveIdentityUrl(config.apiUrl),
    userAgent: "d-env",
  };
}

function maybeStatusCode(message: string): number | undefined {
  const match = message.match(/\b([45]\d{2})\b/);
  if (match === null) {
    return undefined;
  }
  const statusText = match[1];
  if (statusText === undefined) {
    return undefined;
  }
  return Number.parseInt(statusText, 10);
}

function mapBitwardenError(err: unknown): DEnvError {
  if (err instanceof DEnvError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const details: Record<string, unknown> = { provider: PROVIDER_NAME };
  const statusCode = maybeStatusCode(message);
  if (statusCode !== undefined) {
    details["statusCode"] = statusCode;
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("access denied") ||
    lower.includes("permission") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return new DEnvError(
      message || "bitwarden-secret-manager authentication failed",
      {
        code: "provider_auth",
        details,
        cause: err,
      },
    );
  }

  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("unreachable") ||
    (statusCode !== undefined && statusCode >= 500)
  ) {
    return new DEnvError(
      message || "bitwarden-secret-manager provider is unreachable",
      {
        code: "provider_unreachable",
        details,
        cause: err,
      },
    );
  }

  return new DEnvError(
    message || "bitwarden-secret-manager provider request failed",
    {
      code: "provider_unreachable",
      details,
      cause: err,
    },
  );
}

function toProject(value: unknown): BitwardenProject {
  if (!isRecord(value)) {
    throw new TypeError("bitwarden project response must be an object");
  }
  const id = value["id"];
  const organizationId = value["organizationId"];
  if (typeof id !== "string" || typeof organizationId !== "string") {
    throw new TypeError(
      "bitwarden project response must include id and organizationId strings",
    );
  }
  return { id, organizationId };
}

function toSecret(value: unknown): BitwardenSecret {
  if (!isRecord(value)) {
    throw new TypeError("bitwarden secret response must be an object");
  }
  const id = value["id"];
  const key = value["key"];
  const secretValue = value["value"];
  const projectId = value["projectId"];
  if (
    typeof id !== "string" ||
    typeof key !== "string" ||
    typeof secretValue !== "string"
  ) {
    throw new TypeError(
      "bitwarden secret response must include id, key, and value strings",
    );
  }
  if (
    projectId !== undefined &&
    projectId !== null &&
    typeof projectId !== "string"
  ) {
    throw new TypeError("bitwarden secret response projectId must be a string");
  }
  return { id, key, value: secretValue, projectId };
}

async function withSession(
  ctx: ProviderContext,
  config: BitwardenConfig,
): Promise<BitwardenSession> {
  const token = await accessToken(ctx);
  const client = new BitwardenClient(sdkSettings(config), 3);

  try {
    await client.auth().loginAccessToken(token);
    const project = toProject(await client.projects().get(config.projectId));
    return { client, project };
  } catch (err: unknown) {
    throw mapBitwardenError(err);
  }
}

async function fetchProjectSecrets(
  ctx: ProviderContext,
  config: BitwardenConfig,
): Promise<ReadonlyMap<string, BitwardenSecret>> {
  ctx.logger.debug({
    msg: "bitwarden fetch",
    data: { projectId: config.projectId },
  });

  try {
    const session = await withSession(ctx, config);
    let response: unknown;
    try {
      response = await session.client
        .secrets()
        .sync(session.project.organizationId);
    } catch (err: unknown) {
      throw mapBitwardenError(err);
    }
    if (!isRecord(response)) {
      throw new TypeError("bitwarden sync response must be an object");
    }
    const rawSecrets = response["secrets"];
    const secrets = Array.isArray(rawSecrets) ? rawSecrets : [];
    const projectSecrets = new Map<string, BitwardenSecret>();
    for (const rawSecret of secrets) {
      const secret = toSecret(rawSecret);
      if (secret.projectId === config.projectId) {
        projectSecrets.set(secret.key, secret);
      }
    }
    return projectSecrets;
  } catch (err: unknown) {
    if (err instanceof DEnvError) {
      throw err;
    }
    throw new DEnvError(
      "bitwarden-secret-manager provider returned malformed data",
      {
        code: "provider_unreachable",
        details: { provider: PROVIDER_NAME, projectId: config.projectId },
        cause: err,
      },
    );
  }
}

function toSecretMap(secrets: ReadonlyMap<string, BitwardenSecret>): SecretMap {
  const map: Record<string, string> = {};
  for (const [key, secret] of secrets.entries()) {
    map[key] = secret.value;
  }
  return map;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pushSecrets(
  ctx: ProviderContext,
  config: BitwardenConfig,
  changes: ChangeSet,
): Promise<PushResult> {
  ctx.logger.debug({
    msg: "bitwarden push",
    data: {
      projectId: config.projectId,
      upserts: Object.keys(changes.upserts).length,
      deletes: changes.deletes.length,
    },
  });

  const session = await withSession(ctx, config);
  const currentSecrets = await fetchProjectSecrets(ctx, config);
  let wroteAny = false;

  try {
    for (const [key, value] of Object.entries(changes.upserts)) {
      const existing = currentSecrets.get(key);
      if (existing === undefined) {
        await session.client
          .secrets()
          .create(session.project.organizationId, key, value, "", [
            config.projectId,
          ]);
      } else {
        await session.client
          .secrets()
          .update(session.project.organizationId, existing.id, key, value, "", [
            config.projectId,
          ]);
      }
      wroteAny = true;
    }

    const deleteIds = changes.deletes
      .map((key) => currentSecrets.get(key)?.id ?? null)
      .filter((id): id is string => id !== null);
    if (deleteIds.length > 0) {
      await session.client.secrets().delete(deleteIds);
      wroteAny = true;
    }

    return { status: "ok", applied: changes };
  } catch (err: unknown) {
    const mapped = mapBitwardenError(err);
    if (!wroteAny && mapped.code === "provider_auth") {
      throw mapped;
    }
    try {
      return {
        status: "conflict",
        remote: toSecretMap(await fetchProjectSecrets(ctx, config)),
      };
    } catch {
      throw mapped;
    }
  }
}

async function testAuth(
  ctx: ProviderContext,
  config: BitwardenConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  ctx.logger.debug({
    msg: "bitwarden test",
    data: {
      projectId: config.projectId,
      apiUrl: config.apiUrl ?? DEFAULT_API_URL,
    },
  });

  try {
    await withSession(ctx, config);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, reason: errorReason(mapBitwardenError(err)) };
  }
}

const bitwardenSecretManagerProvider: Provider = {
  name: PROVIDER_NAME,
  instanceConfigSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", title: "Project ID" },
      apiUrl: { type: "string", title: "API URL" },
    },
    required: ["projectId"],
  },
  credentialKeys: [ACCESS_TOKEN_KEY],
  create(ctx: ProviderContext, config: unknown): Promise<ProviderInstance> {
    const validated = validateConfig(config);
    return Promise.resolve({
      fetch() {
        return fetchProjectSecrets(ctx, validated).then(toSecretMap);
      },
      push(changes: ChangeSet) {
        return pushSecrets(ctx, validated, changes);
      },
      test() {
        return testAuth(ctx, validated);
      },
    });
  },
};

export default bitwardenSecretManagerProvider;
