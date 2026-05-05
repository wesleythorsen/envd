import { Command } from "commander";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type {
  ControlClient,
  CreateProviderInstanceInput,
  ProviderInstanceDetail,
  ProviderMetadata,
  ProviderTestResult,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import type { JSONSchema } from "../../providers/base.js";
import { DEnvError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";

interface Writable {
  write(chunk: string): unknown;
}

type PromptFn = (
  question: string,
  opts?: { readonly defaultValue?: string },
) => Promise<string>;

type SecretPromptFn = (question: string) => Promise<string>;

type ConfirmFn = (question: string) => Promise<boolean>;

export interface ProviderCommandDeps {
  readonly client?: ControlClient;
  readonly createClient?: () => ControlClient;
  readonly prompt?: PromptFn;
  readonly promptSecret?: SecretPromptFn;
  readonly confirm?: ConfirmFn;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

interface ProviderOptions {
  readonly json?: boolean;
}

interface ProviderAddOptions extends ProviderOptions {
  readonly name?: string;
  readonly configJson?: string;
  readonly credentialsJson?: string;
}

interface ProviderRemoveOptions extends ProviderOptions {
  readonly force?: boolean;
}

export interface ProviderListResult {
  readonly providers: readonly ProviderMetadata[];
  readonly providerInstances: readonly ProviderInstanceDetail[];
}

export interface ProviderAddResult {
  readonly status: "created";
  readonly id: string;
  readonly provider: string;
  readonly name: string;
}

export interface ProviderRemoveResult {
  readonly status: "removed";
  readonly id: string;
}

export interface ProviderTestCommandResult {
  readonly status: "tested";
  readonly id: string;
  readonly result: ProviderTestResult;
}

type SchemaObject = Exclude<JSONSchema, boolean>;

function resolveClient(deps: ProviderCommandDeps): ControlClient {
  if (deps.client !== undefined) {
    return deps.client;
  }
  return (deps.createClient ?? createControlClient)();
}

function out(deps: ProviderCommandDeps, text: string): void {
  (deps.stdout ?? defaultOutput).write(text);
}

function schemaObject(schema: JSONSchema, label: string): SchemaObject {
  if (schema === true) {
    return {};
  }
  if (schema === false) {
    throw new DEnvError(`${label} schema does not allow values`, {
      code: "usage_error",
    });
  }
  return schema;
}

function schemaType(schema: SchemaObject): string | undefined {
  const type = schema.type;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    return type.find(
      (item): item is string => typeof item === "string" && item !== "null",
    );
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (parseErr: unknown) {
    throw new DEnvError(`${label} must be valid JSON`, {
      code: "usage_error",
      cause: parseErr,
    });
  }

  if (!isRecord(parsed)) {
    throw new DEnvError(`${label} must be a JSON object`, {
      code: "usage_error",
    });
  }
  return parsed;
}

function parseCredentialsJson(raw: string): Record<string, string> {
  const parsed = parseJsonObject(raw, "--credentials-json");
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new DEnvError("--credentials-json values must be strings", {
        code: "usage_error",
        details: { key },
      });
    }
    credentials[key] = value;
  }
  return credentials;
}

function defaultPrompt(
  question: string,
  opts?: { readonly defaultValue?: string },
): Promise<string> {
  const suffix =
    opts?.defaultValue === undefined ? "" : ` [${opts.defaultValue}]`;
  const rl = createInterface({ input: defaultInput, output: defaultOutput });
  return rl.question(`${question}${suffix}: `).finally(() => {
    rl.close();
  });
}

function defaultConfirm(question: string): Promise<boolean> {
  return defaultPrompt(`${question} [y/N]`).then((answer) => {
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  });
}

function defaultPromptSecret(question: string): Promise<string> {
  const input = defaultInput;
  const output = defaultOutput;
  if (input.isTTY !== true) {
    const rl = createInterface({ input: defaultInput, output });
    return rl.question(`${question}: `).finally(() => {
      rl.close();
    });
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      output.write("\n");
    };

    const finish = (): void => {
      cleanup();
      resolve(value);
    };

    const cancel = (): void => {
      cleanup();
      reject(new DEnvError("prompt cancelled", { code: "usage_error" }));
    };

    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString("utf-8")) {
        if (char === "\u0003") {
          cancel();
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          return;
        }
        if (char >= " ") {
          value += char;
        }
      }
    };

    output.write(`${question}: `);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function promptWithDefault(
  prompt: PromptFn,
  question: string,
  defaultValue: string,
): Promise<string> {
  const answer = await prompt(question, { defaultValue });
  const trimmed = answer.trim();
  return trimmed === "" ? defaultValue : trimmed;
}

function displayDefault(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function parseBoolean(input: string): boolean | undefined {
  switch (input.trim().toLowerCase()) {
    case "true":
    case "t":
    case "yes":
    case "y":
    case "1":
      return true;
    case "false":
    case "f":
    case "no":
    case "n":
    case "0":
      return false;
    default:
      return undefined;
  }
}

function parseEnumValue(raw: string, values: readonly unknown[]): unknown {
  const index = Number.parseInt(raw, 10);
  if (String(index) === raw.trim() && index >= 1 && index <= values.length) {
    return values[index - 1];
  }

  for (const value of values) {
    if (String(value) === raw) {
      return value;
    }
  }
  return undefined;
}

async function promptConfigValue(
  key: string,
  schema: JSONSchema,
  required: boolean,
  prompt: PromptFn,
): Promise<unknown> {
  const object = schemaObject(schema, `config.${key}`);
  const title = object.title ?? key;
  const hasDefault = object.default !== undefined;
  const defaultValue = displayDefault(object.default);
  const opts = defaultValue === undefined ? undefined : { defaultValue };

  if (object.enum !== undefined) {
    const choices = object.enum
      .map((value, index) => `${index + 1}) ${String(value)}`)
      .join(", ");
    for (;;) {
      const answer = await prompt(`${title} (${choices})`, opts);
      const trimmed = answer.trim();
      if (trimmed === "") {
        if (hasDefault) {
          return object.default;
        }
        if (!required) {
          return undefined;
        }
      } else {
        const value = parseEnumValue(trimmed, object.enum);
        if (value !== undefined) {
          return value;
        }
      }
      out({}, `Invalid value for ${key}; choose one of: ${choices}\n`);
    }
  }

  const type = schemaType(object) ?? "string";
  if (type === "string") {
    for (;;) {
      const answer = await prompt(title, opts);
      if (answer !== "") {
        return answer;
      }
      if (hasDefault) {
        if (typeof object.default === "string") {
          return object.default;
        }
        throw new DEnvError(`default for ${key} must be a string`, {
          code: "usage_error",
          details: { key },
        });
      }
      if (!required) {
        return undefined;
      }
      out({}, `${key} is required\n`);
    }
  }

  if (type === "boolean") {
    const boolDefault =
      typeof object.default === "boolean" ? object.default : undefined;
    const boolOpts =
      boolDefault === undefined
        ? undefined
        : { defaultValue: boolDefault ? "yes" : "no" };
    for (;;) {
      const answer = await prompt(`${title} [y/n]`, boolOpts);
      const trimmed = answer.trim();
      if (trimmed === "") {
        if (boolDefault !== undefined) {
          return boolDefault;
        }
        if (!required) {
          return undefined;
        }
      } else {
        const parsed = parseBoolean(trimmed);
        if (parsed !== undefined) {
          return parsed;
        }
      }
      out({}, `${key} must be yes or no\n`);
    }
  }

  throw new DEnvError(`unsupported config field type for ${key}`, {
    code: "usage_error",
    details: { key, type },
  });
}

async function promptConfig(
  metadata: ProviderMetadata,
  prompt: PromptFn,
): Promise<Record<string, unknown>> {
  const schema = schemaObject(metadata.instanceConfigSchema, "config");
  if (schemaType(schema) !== undefined && schemaType(schema) !== "object") {
    throw new DEnvError("provider config schema must be an object", {
      code: "usage_error",
      details: { provider: metadata.name },
    });
  }

  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const config: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    const value = await promptConfigValue(
      key,
      propertySchema,
      required.has(key),
      prompt,
    );
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}

async function promptCredentials(
  metadata: ProviderMetadata,
  promptSecret: SecretPromptFn,
): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};
  for (const key of metadata.credentialKeys) {
    for (;;) {
      const value = await promptSecret(`Credential ${key}`);
      if (value !== "") {
        credentials[key] = value;
        break;
      }
      out({}, `${key} credential is required\n`);
    }
  }
  return credentials;
}

function inputForCreate(
  provider: string,
  name: string,
  config: Record<string, unknown>,
  credentials: Record<string, string>,
): CreateProviderInstanceInput {
  return { provider, name, config, credentials };
}

async function providerMetadata(
  client: ControlClient,
  providerName: string,
): Promise<ProviderMetadata> {
  const providers = await client.listProviders();
  const metadata = providers.find((provider) => provider.name === providerName);
  if (metadata === undefined) {
    throw new DEnvError("provider is not registered", {
      code: "usage_error",
      details: { provider: providerName },
    });
  }
  return metadata;
}

export async function listProviders(
  deps: ProviderCommandDeps,
): Promise<ProviderListResult> {
  const client = resolveClient(deps);
  const [providers, providerInstances] = await Promise.all([
    client.listProviders(),
    client.listProviderInstances(),
  ]);
  return { providers, providerInstances };
}

export async function addProviderInstance(
  providerName: string,
  options: ProviderAddOptions,
  deps: ProviderCommandDeps,
): Promise<ProviderAddResult> {
  const client = resolveClient(deps);
  const metadata = await providerMetadata(client, providerName);
  const prompt = deps.prompt ?? defaultPrompt;
  const promptSecret = deps.promptSecret ?? defaultPromptSecret;
  const name =
    options.name ??
    (defaultInput.isTTY === true
      ? await promptWithDefault(prompt, "Instance name", providerName)
      : providerName);
  if (name.trim() === "") {
    throw new DEnvError("provider instance name must be non-empty", {
      code: "usage_error",
    });
  }

  const config =
    options.configJson === undefined
      ? await promptConfig(metadata, prompt)
      : parseJsonObject(options.configJson, "--config-json");
  const credentials =
    options.credentialsJson === undefined
      ? await promptCredentials(metadata, promptSecret)
      : parseCredentialsJson(options.credentialsJson);

  const created = await client.createProviderInstance(
    inputForCreate(providerName, name, config, credentials),
  );
  return {
    status: "created",
    id: created.id,
    provider: providerName,
    name,
  };
}

export async function removeProviderInstance(
  id: string,
  options: ProviderRemoveOptions,
  deps: ProviderCommandDeps,
): Promise<ProviderRemoveResult> {
  const confirm = deps.confirm ?? defaultConfirm;
  if (options.force !== true) {
    const shouldRemove = await confirm(`Remove provider instance ${id}?`);
    if (!shouldRemove) {
      throw new DEnvError("provider instance removal cancelled", {
        code: "usage_error",
      });
    }
  }

  const client = resolveClient(deps);
  await client.deleteProviderInstance(id);
  return { status: "removed", id };
}

export async function testProviderInstance(
  id: string,
  deps: ProviderCommandDeps,
): Promise<ProviderTestCommandResult> {
  const client = resolveClient(deps);
  return {
    status: "tested",
    id,
    result: await client.testProviderInstance(id),
  };
}

function printList(
  result: ProviderListResult,
  json: boolean,
  deps: ProviderCommandDeps,
): void {
  if (json) {
    out(deps, JSON.stringify(result) + "\n");
    return;
  }

  out(deps, "Providers:\n");
  for (const provider of result.providers) {
    const schema = schemaObject(provider.instanceConfigSchema, "config");
    const configKeys = Object.keys(schema.properties ?? {});
    out(
      deps,
      `  ${provider.name} (config: ${configKeys.join(", ") || "none"}; credentials: ${
        provider.credentialKeys.join(", ") || "none"
      })\n`,
    );
  }

  out(deps, "Instances:\n");
  if (result.providerInstances.length === 0) {
    out(deps, "  none\n");
    return;
  }
  for (const instance of result.providerInstances) {
    out(
      deps,
      `  ${instance.id}  ${instance.name}  provider=${instance.provider}  config=${JSON.stringify(
        instance.config,
      )}\n`,
    );
  }
}

function printAdd(
  result: ProviderAddResult,
  json: boolean,
  deps: ProviderCommandDeps,
): void {
  if (json) {
    out(deps, JSON.stringify(result) + "\n");
    return;
  }
  out(deps, `provider instance created (${result.id})\n`);
}

function printRemove(
  result: ProviderRemoveResult,
  json: boolean,
  deps: ProviderCommandDeps,
): void {
  if (json) {
    out(deps, JSON.stringify(result) + "\n");
    return;
  }
  out(deps, `provider instance removed (${result.id})\n`);
}

function printTest(
  result: ProviderTestCommandResult,
  json: boolean,
  deps: ProviderCommandDeps,
): void {
  if (json) {
    out(deps, JSON.stringify(result) + "\n");
    return;
  }

  if (result.result.ok) {
    out(deps, `provider instance test passed (${result.id})\n`);
    return;
  }
  out(
    deps,
    `provider instance test failed (${result.id}): ${result.result.reason}\n`,
  );
}

function handleProviderError(
  errValue: unknown,
  deps: ProviderCommandDeps,
): void {
  writeCliError(errValue, deps);
}

export function buildProviderCommand(deps: ProviderCommandDeps = {}): Command {
  const provider = new Command("provider").description(
    "Manage provider instances",
  );

  provider
    .command("list")
    .description("List registered providers and configured instances")
    .option("--json", "JSON output")
    .action(async (opts: ProviderOptions) => {
      try {
        printList(await listProviders(deps), opts.json === true, deps);
      } catch (error: unknown) {
        handleProviderError(error, deps);
      }
    });

  provider
    .command("add")
    .description("Add a provider instance")
    .argument("<provider>", "registered provider name")
    .option("--name <name>", "provider instance display name")
    .option("--config-json <json>", "provider config JSON object")
    .option("--credentials-json <json>", "provider credentials JSON object")
    .option("--json", "JSON output")
    .action(async (providerName: string, opts: ProviderAddOptions) => {
      try {
        printAdd(
          await addProviderInstance(providerName, opts, deps),
          opts.json === true,
          deps,
        );
      } catch (error: unknown) {
        handleProviderError(error, deps);
      }
    });

  provider
    .command("remove")
    .description("Remove a provider instance")
    .argument("<id>", "provider instance id")
    .option("--force", "skip confirmation prompt")
    .option("--json", "JSON output")
    .action(async (id: string, opts: ProviderRemoveOptions) => {
      try {
        printRemove(
          await removeProviderInstance(id, opts, deps),
          opts.json === true,
          deps,
        );
      } catch (error: unknown) {
        handleProviderError(error, deps);
      }
    });

  provider
    .command("test")
    .description("Test a provider instance")
    .argument("<id>", "provider instance id")
    .option("--json", "JSON output")
    .action(async (id: string, opts: ProviderOptions) => {
      try {
        printTest(
          await testProviderInstance(id, deps),
          opts.json === true,
          deps,
        );
      } catch (error: unknown) {
        handleProviderError(error, deps);
      }
    });

  return provider;
}
