import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { EnvdError } from "../../shared/errors.js";
import type {
  ChangeSet,
  Provider,
  ProviderContext,
  ProviderInstance,
  PushResult,
  SecretMap,
} from "../base.js";

interface AwsSecretsManagerConfig {
  readonly region: string;
  readonly secretPrefix: string;
  readonly profile?: string;
  readonly endpoint?: string;
  readonly deleteMode: "force" | "recoverable";
}

interface RemoteSecret {
  readonly name: string;
  readonly key: string;
  readonly value: string;
}

const PROVIDER_NAME = "aws-secrets-manager";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateOptionalString(
  raw: unknown,
  label: string,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new EnvdError(`${label} must be a string`, {
      code: "usage_error",
    });
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new EnvdError(`${label} must be non-empty`, {
      code: "usage_error",
    });
  }
  return trimmed;
}

function validateConfig(config: unknown): AwsSecretsManagerConfig {
  if (!isRecord(config)) {
    throw new EnvdError(
      "aws-secrets-manager provider config must be a JSON object",
      {
        code: "usage_error",
      },
    );
  }

  const region = validateOptionalString(config["region"], "config.region");
  if (region === undefined) {
    throw new EnvdError("aws-secrets-manager provider requires config.region", {
      code: "usage_error",
    });
  }

  const secretPrefix = validateOptionalString(
    config["secretPrefix"],
    "config.secretPrefix",
  );
  if (secretPrefix === undefined) {
    throw new EnvdError(
      "aws-secrets-manager provider requires config.secretPrefix",
      {
        code: "usage_error",
      },
    );
  }

  const endpoint = validateOptionalString(
    config["endpoint"],
    "config.endpoint",
  );
  if (endpoint !== undefined) {
    try {
      new URL(endpoint);
    } catch (err: unknown) {
      throw new EnvdError(
        "aws-secrets-manager provider config.endpoint must be a URL",
        {
          code: "usage_error",
          cause: err,
        },
      );
    }
  }

  const deleteModeRaw = config["deleteMode"];
  if (
    deleteModeRaw !== undefined &&
    deleteModeRaw !== "force" &&
    deleteModeRaw !== "recoverable"
  ) {
    throw new EnvdError(
      'aws-secrets-manager provider config.deleteMode must be "force" or "recoverable"',
      {
        code: "usage_error",
      },
    );
  }

  const profile = validateOptionalString(config["profile"], "config.profile");
  return {
    region,
    secretPrefix: secretPrefix.replace(/\/+$/, ""),
    deleteMode: deleteModeRaw === "recoverable" ? "recoverable" : "force",
    ...(profile !== undefined ? { profile } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

function remoteSecretName(
  config: AwsSecretsManagerConfig,
  key: string,
): string {
  return `${config.secretPrefix}/${key}`;
}

function localKeyFromName(
  config: AwsSecretsManagerConfig,
  name: string,
): string | null {
  const prefix = `${config.secretPrefix}/`;
  if (!name.startsWith(prefix)) {
    return null;
  }
  const key = name.slice(prefix.length);
  return key === "" ? null : key;
}

function maybeStatusCode(err: unknown): number | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  const metadata = err["$metadata"];
  if (!isRecord(metadata)) {
    return undefined;
  }
  const status = metadata["httpStatusCode"];
  return typeof status === "number" ? status : undefined;
}

function errorName(err: unknown): string | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  const name = err["name"];
  return typeof name === "string" ? name : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapAwsError(err: unknown): EnvdError {
  if (err instanceof EnvdError) {
    return err;
  }

  const name = errorName(err);
  const message = errorMessage(err);
  const lower = message.toLowerCase();
  const statusCode = maybeStatusCode(err);
  const details: Record<string, unknown> = { provider: PROVIDER_NAME };
  if (name !== undefined) {
    details["errorName"] = name;
  }
  if (statusCode !== undefined) {
    details["statusCode"] = statusCode;
  }

  const authNames = new Set([
    "AccessDeniedException",
    "UnrecognizedClientException",
    "InvalidClientTokenId",
    "ExpiredTokenException",
    "CredentialsProviderError",
    "InvalidSignatureException",
  ]);
  if (
    (name !== undefined && authNames.has(name)) ||
    lower.includes("credential") ||
    lower.includes("access denied") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new EnvdError(
      message || "aws secrets manager authentication failed",
      {
        code: "provider_auth",
        details,
        cause: err,
      },
    );
  }

  const unreachableNames = new Set([
    "ThrottlingException",
    "TooManyRequestsException",
    "TimeoutError",
    "NetworkingError",
    "InternalServiceError",
    "InternalFailure",
    "ServiceUnavailableException",
    "RequestTimeout",
  ]);
  if (
    (name !== undefined && unreachableNames.has(name)) ||
    lower.includes("throttl") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("network") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("unreachable") ||
    (statusCode !== undefined && statusCode >= 500)
  ) {
    return new EnvdError(
      message || "aws secrets manager provider is unreachable",
      {
        code: "provider_unreachable",
        details,
        cause: err,
      },
    );
  }

  return new EnvdError(message || "aws secrets manager request failed", {
    code: "provider_unreachable",
    details,
    cause: err,
  });
}

function createClient(config: AwsSecretsManagerConfig): SecretsManagerClient {
  const clientConfig: ConstructorParameters<typeof SecretsManagerClient>[0] = {
    region: config.region,
  };
  if (config.endpoint !== undefined) {
    clientConfig.endpoint = config.endpoint;
  }
  if (config.profile !== undefined) {
    clientConfig.credentials = fromIni({ profile: config.profile });
  }
  return new SecretsManagerClient(clientConfig);
}

async function listSecretNames(
  client: SecretsManagerClient,
  config: AwsSecretsManagerConfig,
): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(
      new ListSecretsCommand({
        NextToken: nextToken,
        Filters: [{ Key: "name", Values: [`${config.secretPrefix}/`] }],
      }),
    );
    for (const secret of response.SecretList ?? []) {
      if (typeof secret.Name !== "string") {
        continue;
      }
      if (localKeyFromName(config, secret.Name) !== null) {
        names.push(secret.Name);
      }
    }
    nextToken = response.NextToken;
  } while (nextToken !== undefined);
  return names;
}

async function fetchSecrets(
  ctx: ProviderContext,
  config: AwsSecretsManagerConfig,
): Promise<ReadonlyMap<string, RemoteSecret>> {
  ctx.logger.debug({
    msg: "aws secrets manager fetch",
    data: { region: config.region, secretPrefix: config.secretPrefix },
  });

  const client = createClient(config);
  try {
    const names = await listSecretNames(client, config);
    const remote = new Map<string, RemoteSecret>();
    for (const name of names) {
      const key = localKeyFromName(config, name);
      if (key === null) {
        continue;
      }
      const response = await client.send(
        new GetSecretValueCommand({ SecretId: name }),
      );
      if (typeof response.SecretString !== "string") {
        if (response.SecretBinary !== undefined) {
          throw new TypeError(
            `aws secrets manager secret ${name} uses SecretBinary, which is unsupported`,
          );
        }
        throw new TypeError(
          `aws secrets manager secret ${name} does not contain a SecretString`,
        );
      }
      remote.set(key, { key, name, value: response.SecretString });
    }
    return remote;
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      throw new EnvdError(err.message, {
        code: "provider_unreachable",
        details: { provider: PROVIDER_NAME, secretPrefix: config.secretPrefix },
        cause: err,
      });
    }
    throw mapAwsError(err);
  } finally {
    client.destroy();
  }
}

function toSecretMap(remote: ReadonlyMap<string, RemoteSecret>): SecretMap {
  const map: Record<string, string> = {};
  for (const [key, secret] of remote.entries()) {
    map[key] = secret.value;
  }
  return map;
}

async function testAuth(
  ctx: ProviderContext,
  config: AwsSecretsManagerConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  ctx.logger.debug({
    msg: "aws secrets manager test",
    data: { region: config.region, secretPrefix: config.secretPrefix },
  });

  const client = createClient(config);
  try {
    await client.send(
      new ListSecretsCommand({
        MaxResults: 1,
        Filters: [{ Key: "name", Values: [`${config.secretPrefix}/`] }],
      }),
    );
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, reason: errorMessage(mapAwsError(err)) };
  } finally {
    client.destroy();
  }
}

function deleteInput(
  config: AwsSecretsManagerConfig,
  name: string,
): ConstructorParameters<typeof DeleteSecretCommand>[0] {
  if (config.deleteMode === "recoverable") {
    return { SecretId: name, RecoveryWindowInDays: 7 };
  }
  return { SecretId: name, ForceDeleteWithoutRecovery: true };
}

async function pushSecrets(
  ctx: ProviderContext,
  config: AwsSecretsManagerConfig,
  changes: ChangeSet,
): Promise<PushResult> {
  ctx.logger.debug({
    msg: "aws secrets manager push",
    data: {
      region: config.region,
      secretPrefix: config.secretPrefix,
      upserts: Object.keys(changes.upserts).length,
      deletes: changes.deletes.length,
    },
  });

  const currentSecrets = await fetchSecrets(ctx, config);
  const client = createClient(config);
  let wroteAny = false;

  try {
    for (const [key, value] of Object.entries(changes.upserts)) {
      const existing = currentSecrets.get(key);
      if (existing === undefined) {
        await client.send(
          new CreateSecretCommand({
            Name: remoteSecretName(config, key),
            SecretString: value,
          }),
        );
      } else {
        await client.send(
          new PutSecretValueCommand({
            SecretId: existing.name,
            SecretString: value,
          }),
        );
      }
      wroteAny = true;
    }

    for (const key of changes.deletes) {
      const existing = currentSecrets.get(key);
      if (existing === undefined) {
        continue;
      }
      await client.send(
        new DeleteSecretCommand(deleteInput(config, existing.name)),
      );
      wroteAny = true;
    }

    return { status: "ok", applied: changes };
  } catch (err: unknown) {
    const mapped = mapAwsError(err);
    if (!wroteAny && mapped.code === "provider_auth") {
      throw mapped;
    }
    try {
      return {
        status: "conflict",
        remote: toSecretMap(await fetchSecrets(ctx, config)),
      };
    } catch {
      throw mapped;
    }
  } finally {
    client.destroy();
  }
}

const awsSecretsManagerProvider: Provider = {
  name: PROVIDER_NAME,
  environmentMode: "config-adapter",
  instanceConfigSchema: {
    type: "object",
    properties: {
      region: { type: "string", title: "AWS region" },
      secretPrefix: { type: "string", title: "Secret prefix" },
      profile: { type: "string", title: "AWS profile" },
      endpoint: { type: "string", title: "AWS endpoint URL" },
      deleteMode: {
        title: "Delete mode",
        enum: ["force", "recoverable"],
      },
    },
    required: ["region", "secretPrefix"],
  },
  credentialKeys: [],
  create(ctx: ProviderContext, config: unknown): Promise<ProviderInstance> {
    const validated = validateConfig(config);
    return Promise.resolve({
      fetch() {
        return fetchSecrets(ctx, validated).then(toSecretMap);
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

export default awsSecretsManagerProvider;
