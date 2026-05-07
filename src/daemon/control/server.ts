import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readLogTail } from "../../shared/log-file.js";
import { createLogger, subscribeLogLines } from "../../shared/logger.js";
import { safeErrorLogData } from "../../shared/log-safety.js";
import { EnvdError, type ErrorCode } from "../../shared/errors.js";
import type {
  Project,
  ProjectEnvironment,
  ProjectRepo,
} from "../../core/project.js";
import { createCache, type Cache, type CacheResult } from "../../core/cache.js";
import type { StagedDesiredMap, StagingRepo } from "../../core/staging.js";
import {
  ProviderInstanceRepo,
  type ProviderInstanceRecord,
} from "../../core/provider-instance.js";
import { daemonLogFile, mountPath } from "../../shared/paths.js";
import { providers, findProvider } from "../../providers/registry.js";
import type {
  ChangeSet,
  KeychainAdapter,
  Provider,
  ProviderContext,
  ProviderInstance,
  PushResult,
  SecretMap,
} from "../../providers/base.js";
import {
  diffSecrets,
  toSecretDiffKeys,
  type SecretDiff,
  type SecretDiffKeys,
} from "../../kinds/secrets/diff.js";
import { createKeychainAdapter } from "../../core/keychain.js";
import { readJsonBody } from "./body.js";

// createRequire is the stable way to load JSON in ESM without import assertions
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require("../../../package.json");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const PKG_VERSION = pkg.version as string;

const log = createLogger("daemon/control");

const START_TIME = Date.now();
const DEFAULT_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ControlServerOpts {
  /** TCP port to bind. Pass 0 for an ephemeral port (tests). Default: 1910. */
  port?: number;
  /**
   * Auth token. When provided, filesystem bootstrap is skipped — used by
   * tests to supply the token directly without touching ~/.envd/.
   */
  token: string;
  /**
   * Called after the 204 response is flushed on POST /v1/shutdown.
   * If not provided, the endpoint returns 204 but takes no shutdown action
   * (useful for unit tests that don't want the process to exit).
   */
  onShutdown?: () => void;
  projectRepo?: ProjectRepo;
  providerInstanceRepo?: ProviderInstanceRepo;
  stagingRepo?: StagingRepo;
  keychain?: KeychainAdapter;
  cache?: Cache<SecretMap>;
}

export interface ControlServerHandle {
  /** The actual TCP port the server is listening on. */
  port: number;
  /** Gracefully closes the HTTP server. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** Writes a JSON response with the correct Content-Type. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  const buf = Buffer.from(json, "utf-8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

/** Writes a canonical error response. */
function writeJsonError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: {
    error: {
      code: ErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };
  } = {
    error: { code, message },
  };
  if (details !== undefined) {
    body.error.details = details;
  }
  writeJson(res, status, body);
}

function statusForErrorCode(code: ErrorCode): number {
  switch (code) {
    case "usage_error":
    case "bad_dotenv":
      return 400;
    case "unauthorized":
      return 401;
    case "not_initialized":
    case "not_found":
      return 404;
    case "method_not_allowed":
      return 405;
    case "commit_conflict":
      return 409;
    case "daemon_unreachable":
    case "provider_unreachable":
    case "provider_auth":
    case "mount_failed":
    case "internal":
      return 500;
  }
}

function writeErrorFromUnknown(res: ServerResponse, err: unknown): void {
  if (err instanceof EnvdError) {
    writeJsonError(
      res,
      statusForErrorCode(err.code),
      err.code,
      err.message,
      err.details,
    );
    return;
  }

  writeJsonError(res, 500, "internal", "Internal error");
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of two strings as UTF-8 bytes.
 * Returns false immediately if lengths differ (timingSafeEqual throws on mismatch).
 */
function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Validates the Authorization header. Returns true if the bearer token matches.
 * On failure, writes the 401 response and returns false.
 */
function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): boolean {
  const authHeader = req.headers["authorization"];
  if (authHeader === undefined || authHeader === "") {
    writeJsonError(res, 401, "unauthorized", "Missing Authorization header");
    return false;
  }

  if (!authHeader.startsWith("Bearer ")) {
    writeJsonError(
      res,
      401,
      "unauthorized",
      "Authorization header must use Bearer scheme",
    );
    return false;
  }

  const supplied = authHeader.slice("Bearer ".length);
  if (!tokensEqual(supplied, token)) {
    writeJsonError(res, 401, "unauthorized", "Invalid token");
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleHealth(res: ServerResponse): void {
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
  writeJson(res, 200, { ok: true, version: PKG_VERSION, uptimeSec });
}

function handleVersion(res: ServerResponse): void {
  writeJson(res, 200, { cli: null, daemon: PKG_VERSION, protocol: "v1" });
}

function parseLogsRequest(req: IncomingMessage): {
  tail: number;
  follow: boolean;
} {
  const url = new URL(req.url ?? "/v1/logs", "http://127.0.0.1");
  const tailRaw = url.searchParams.get("tail");
  const followRaw = url.searchParams.get("follow");
  const tail =
    tailRaw === null || tailRaw === "" ? 100 : Number.parseInt(tailRaw, 10);

  if (!Number.isInteger(tail) || tail < 0) {
    throw new EnvdError("tail must be a non-negative integer", {
      code: "usage_error",
    });
  }

  return {
    tail,
    follow: followRaw === "true",
  };
}

function writeSseLine(res: ServerResponse, line: string): void {
  res.write(`data: ${JSON.stringify({ line })}\n\n`);
}

function handleGetLogs(req: IncomingMessage, res: ServerResponse): void {
  const { tail, follow } = parseLogsRequest(req);
  const lines = readLogTail(daemonLogFile(), tail);

  if (!follow) {
    writeJson(res, 200, { lines });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const line of lines) {
    writeSseLine(res, line);
  }

  const unsubscribe = subscribeLogLines((line) => {
    writeSseLine(res, line);
  });
  req.on("close", () => {
    unsubscribe();
    res.end();
  });
}

/**
 * Sends 204 and triggers graceful shutdown after the response is fully written.
 * Shutdown is scheduled via setImmediate so the response bytes leave the socket
 * before the server begins closing — otherwise the client sees a connection reset
 * instead of a clean 204.
 */
function handleShutdown(res: ServerResponse, onShutdown?: () => void): void {
  res.writeHead(204);
  res.end(() => {
    if (onShutdown !== undefined) {
      setImmediate(onShutdown);
    }
  });
}

function requireProjectRepo(projectRepo: ProjectRepo | undefined): ProjectRepo {
  if (projectRepo === undefined) {
    throw new EnvdError("project registry is not available", {
      code: "internal",
    });
  }
  return projectRepo;
}

function requireProviderInstanceRepo(
  providerInstanceRepo: ProviderInstanceRepo | undefined,
): ProviderInstanceRepo {
  if (providerInstanceRepo === undefined) {
    throw new EnvdError("provider instance registry is not available", {
      code: "internal",
    });
  }
  return providerInstanceRepo;
}

function requireStagingRepo(stagingRepo: StagingRepo | undefined): StagingRepo {
  if (stagingRepo === undefined) {
    throw new EnvdError("staging registry is not available", {
      code: "internal",
    });
  }
  return stagingRepo;
}

function requireKeychain(
  keychain: KeychainAdapter | undefined,
): KeychainAdapter {
  if (keychain === undefined) {
    throw new EnvdError("keychain adapter is not available", {
      code: "internal",
    });
  }
  return keychain;
}

function projectMountPath(id: string, token: string): string {
  return `${mountPath()}/p/${id}.${token}/.env`;
}

function parseProjectCreateBody(body: unknown): {
  path: string;
  providerInstanceId?: string;
  format?: string;
  formatConfig?: string;
} {
  if (body === null || typeof body !== "object" || !("path" in body)) {
    throw new EnvdError("request body must include path", {
      code: "usage_error",
    });
  }

  const path = (body as { path?: unknown }).path;
  if (typeof path !== "string" || path === "") {
    throw new EnvdError("path must be a non-empty string", {
      code: "usage_error",
    });
  }

  const input: {
    path: string;
    providerInstanceId?: string;
    format?: string;
    formatConfig?: string;
  } = { path };
  const providerInstanceId = (body as { providerInstanceId?: unknown })
    .providerInstanceId;
  if (providerInstanceId !== undefined) {
    if (typeof providerInstanceId !== "string" || providerInstanceId === "") {
      throw new EnvdError("providerInstanceId must be a non-empty string", {
        code: "usage_error",
      });
    }
    input.providerInstanceId = providerInstanceId;
  }

  const format = (body as { format?: unknown }).format;
  if (format !== undefined) {
    if (typeof format !== "string" || format === "") {
      throw new EnvdError("format must be a non-empty string", {
        code: "usage_error",
      });
    }
    input.format = format;
  }

  const formatConfig = (body as { formatConfig?: unknown }).formatConfig;
  if (formatConfig !== undefined) {
    if (typeof formatConfig !== "string" || formatConfig === "") {
      throw new EnvdError("formatConfig must be a non-empty string", {
        code: "usage_error",
      });
    }
    input.formatConfig = formatConfig;
  }

  return input;
}

async function handleCreateProject(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
): Promise<void> {
  const repo = requireProjectRepo(projectRepo);
  const body = await readJsonBody(req);
  const input = parseProjectCreateBody(body);
  const project = repo.create(input);
  writeJson(res, 201, {
    id: project.id,
    token: project.token,
    mountPath: projectMountPath(project.id, project.token),
  });
}

function handleListProjects(
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
): void {
  const repo = requireProjectRepo(projectRepo);
  writeJson(res, 200, { projects: repo.list() });
}

function handleGetProject(
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  id: string,
): void {
  const repo = requireProjectRepo(projectRepo);
  const project = repo.get(id);
  if (project === undefined) {
    writeJsonError(res, 404, "not_found", "Project not found");
    return;
  }
  writeJson(res, 200, {
    ...project,
    mountPath: projectMountPath(project.id, project.token),
  });
}

function handleListProjectEnvironments(
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  id: string,
): void {
  const repo = requireProjectRepo(projectRepo);
  if (repo.get(id) === undefined) {
    writeJsonError(res, 404, "not_found", "Project not found");
    return;
  }
  writeJson(res, 200, { environments: repo.listEnvironments(id) });
}

async function handleCreateProjectEnvironment(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  id: string,
): Promise<void> {
  const repo = requireProjectRepo(projectRepo);
  const body = await readJsonBody(req);
  const name = (body as { name?: unknown }).name;
  const providerEnvironment = (body as { providerEnvironment?: unknown })
    .providerEnvironment;
  if (typeof name !== "string" || name.trim() === "") {
    throw new EnvdError("environment name must be a non-empty string", {
      code: "usage_error",
    });
  }
  if (
    providerEnvironment !== undefined &&
    (typeof providerEnvironment !== "string" ||
      providerEnvironment.trim() === "")
  ) {
    throw new EnvdError(
      "providerEnvironment must be a non-empty string when provided",
      { code: "usage_error" },
    );
  }
  const environment = repo.createEnvironment(id, name, providerEnvironment);
  writeJson(res, 201, environment);
}

async function handleSetProjectActiveEnvironment(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  id: string,
): Promise<void> {
  const repo = requireProjectRepo(projectRepo);
  const body = await readJsonBody(req);
  const name = (body as { name?: unknown }).name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new EnvdError("environment name must be a non-empty string", {
      code: "usage_error",
    });
  }
  const project = repo.setActiveEnvironment(id, name);
  writeJson(res, 200, {
    ...project,
    mountPath: projectMountPath(project.id, project.token),
  });
}

function emptySecretDiffKeys(): SecretDiffKeys {
  return { added: [], modified: [], deleted: [] };
}

function emptySecretDiff(): SecretDiff {
  return { added: {}, modified: {}, deleted: {} };
}

function requestIncludesValues(req: IncomingMessage): boolean {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("values") === "true";
  } catch {
    return false;
  }
}

function requestEnvironment(req: IncomingMessage): string | undefined {
  try {
    const value = new URL(req.url ?? "/", "http://localhost").searchParams.get(
      "environment",
    );
    return value === null || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function environmentFromBody(
  body: Record<string, unknown>,
): string | undefined {
  const environment = body["environment"];
  if (environment === undefined) {
    return undefined;
  }
  if (typeof environment !== "string" || environment.trim() === "") {
    throw new EnvdError("environment must be a non-empty string", {
      code: "usage_error",
    });
  }
  return environment;
}

function resolveProjectEnvironment(
  projects: ProjectRepo,
  project: Project,
  requested: string | undefined,
): ProjectEnvironment {
  const environment = requested ?? project.activeEnvironment;
  const projectEnvironment = projects.getEnvironment(project.id, environment);
  if (projectEnvironment === undefined) {
    throw new EnvdError("environment does not exist", {
      code: "not_found",
      details: { projectId: project.id, environment },
    });
  }
  return projectEnvironment;
}

function stagedDesiredToSecretMap(desired: StagedDesiredMap): SecretMap {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value !== null) {
      map[key] = value;
    }
  }
  return map;
}

function scopedProjectKey(projectId: string, environment: string): string {
  return `${projectId}\0${environment}`;
}

function environmentConfig(config: unknown, environment: string): unknown {
  if (!isRecord(config) || !isRecord(config["environments"])) {
    return config;
  }

  const environmentConfigValue = config["environments"][environment];
  if (environmentConfigValue !== undefined) {
    return environmentConfigValue;
  }

  const defaultConfigValue = config["environments"]["default"];
  return defaultConfigValue === undefined ? config : defaultConfigValue;
}

async function fetchProjectSecrets(
  projectId: string,
  providerEnvironment: string,
  providerInstanceId: string | null,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
): Promise<SecretMap> {
  if (providerInstanceId === null) {
    throw new EnvdError("project has no provider instance", {
      code: "usage_error",
      details: { projectId },
    });
  }

  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const keychainAdapter = requireKeychain(keychain);
  const record = repo.get(providerInstanceId);
  if (record === undefined) {
    throw new EnvdError("provider instance not found", {
      code: "provider_unreachable",
      details: { providerInstanceId },
    });
  }

  const provider = findProvider(record.provider);
  if (provider === undefined) {
    throw new EnvdError("provider is not registered", {
      code: "usage_error",
      details: { provider: record.provider },
    });
  }

  try {
    const instance: ProviderInstance = await provider.create(
      providerContext(keychainAdapter, record.id, provider.name, {
        projectId,
        environment: providerEnvironment,
      }),
      environmentConfig(parseStoredConfig(record), providerEnvironment),
    );
    try {
      return await instance.fetch();
    } finally {
      if (instance.close !== undefined) {
        await instance.close();
      }
    }
  } catch (err: unknown) {
    if (err instanceof EnvdError) {
      throw err;
    }
    throw new EnvdError("provider is unreachable", {
      code: "provider_unreachable",
      cause: err,
    });
  }
}

function readCacheTtlMs(config: unknown): number {
  if (!isRecord(config)) {
    return DEFAULT_CACHE_TTL_MS;
  }

  const raw = config["cacheTtlMs"] ?? config["ttlMs"];
  if (raw === undefined) {
    return DEFAULT_CACHE_TTL_MS;
  }

  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new EnvdError(
      "provider instance cache TTL must be a non-negative number",
      {
        code: "internal",
      },
    );
  }

  return raw;
}

async function readProjectSecrets(
  projectId: string,
  environment: string,
  providerEnvironment: string,
  providerInstanceId: string | null,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
): Promise<CacheResult<SecretMap>> {
  if (providerInstanceId === null) {
    throw new EnvdError("project has no provider instance", {
      code: "usage_error",
      details: { projectId },
    });
  }

  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const record = repo.get(providerInstanceId);
  if (record === undefined) {
    throw new EnvdError("provider instance not found", {
      code: "provider_unreachable",
      details: { providerInstanceId },
    });
  }

  const ttlMs = readCacheTtlMs(
    environmentConfig(parseStoredConfig(record), providerEnvironment),
  );
  return await cache.get(
    scopedProjectKey(projectId, environment),
    () =>
      fetchProjectSecrets(
        projectId,
        providerEnvironment,
        providerInstanceId,
        providerInstanceRepo,
        keychain,
      ),
    { ttlMs },
  );
}

async function refreshProjectSecrets(
  projectId: string,
  environment: string,
  providerEnvironment: string,
  providerInstanceId: string | null,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
): Promise<CacheResult<SecretMap>> {
  if (providerInstanceId === null) {
    throw new EnvdError("project has no provider instance", {
      code: "usage_error",
      details: { projectId },
    });
  }

  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const record = repo.get(providerInstanceId);
  if (record === undefined) {
    throw new EnvdError("provider instance not found", {
      code: "provider_unreachable",
      details: { providerInstanceId },
    });
  }

  const ttlMs = readCacheTtlMs(
    environmentConfig(parseStoredConfig(record), providerEnvironment),
  );
  const cacheKey = scopedProjectKey(projectId, environment);
  cache.invalidate(cacheKey);
  return await cache.get(
    cacheKey,
    () =>
      fetchProjectSecrets(
        projectId,
        providerEnvironment,
        providerInstanceId,
        providerInstanceRepo,
        keychain,
      ),
    { ttlMs },
  );
}

async function readBaselineProjectSecrets(
  projectId: string,
  environment: string,
  providerEnvironment: string,
  providerInstanceId: string | null,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
): Promise<CacheResult<SecretMap>> {
  return await cache.get(
    scopedProjectKey(projectId, environment),
    () =>
      fetchProjectSecrets(
        projectId,
        providerEnvironment,
        providerInstanceId,
        providerInstanceRepo,
        keychain,
      ),
    { ttlMs: Number.MAX_SAFE_INTEGER },
  );
}

async function handleGetProjectDiff(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  stagingRepo: StagingRepo | undefined,
  keychain: KeychainAdapter | undefined,
  id: string,
): Promise<void> {
  const projects = requireProjectRepo(projectRepo);
  const staging = requireStagingRepo(stagingRepo);
  const project = projects.get(id);
  if (project === undefined) {
    writeJsonError(res, 404, "not_found", "Project not found");
    return;
  }

  const includeValues = requestIncludesValues(req);
  const projectEnvironment = resolveProjectEnvironment(
    projects,
    project,
    requestEnvironment(req),
  );
  const environment = projectEnvironment.name;
  const desired = staging.getDesired(id, environment);
  if (desired === undefined) {
    writeJson(
      res,
      200,
      includeValues
        ? { keys: emptySecretDiffKeys(), values: emptySecretDiff() }
        : { keys: emptySecretDiffKeys() },
    );
    return;
  }

  const remote = await fetchProjectSecrets(
    id,
    projectEnvironment.providerEnvironment,
    project.providerInstanceId,
    providerInstanceRepo,
    keychain,
  );
  const diff = diffSecrets(remote, stagedDesiredToSecretMap(desired));
  const keys = toSecretDiffKeys(diff);
  writeJson(res, 200, includeValues ? { keys, values: diff } : { keys });
}

interface StagingSummary {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly total: number;
}

function summarizeStaging(keys: SecretDiffKeys): StagingSummary {
  const added = keys.added.length;
  const modified = keys.modified.length;
  const deleted = keys.deleted.length;
  return {
    added,
    modified,
    deleted,
    total: added + modified + deleted,
  };
}

async function handleGetProjectStatus(
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  stagingRepo: StagingRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
  id: string,
): Promise<void> {
  const projects = requireProjectRepo(projectRepo);
  const staging = requireStagingRepo(stagingRepo);
  const project = projects.get(id);
  if (project === undefined) {
    writeJsonError(res, 404, "not_found", "Project not found");
    return;
  }

  const projectEnvironment = resolveProjectEnvironment(
    projects,
    project,
    undefined,
  );
  const desired = staging.getDesired(id, project.activeEnvironment);
  const cacheKey = scopedProjectKey(id, project.activeEnvironment);
  const cached = cache.peek(cacheKey);
  let provider: string | null = null;
  let providerInstanceName: string | null = null;
  let providerHealthy: boolean | null = null;
  let providerError: string | null = null;
  let lastFetchTime: number | null = cached?.fetchedAt ?? null;
  let remote: SecretMap | undefined = cached?.value;

  if (project.providerInstanceId !== null) {
    const providerRepo = requireProviderInstanceRepo(providerInstanceRepo);
    const record = providerRepo.get(project.providerInstanceId);
    if (record === undefined) {
      providerHealthy = false;
      providerError = "provider instance not found";
    } else {
      provider = record.provider;
      providerInstanceName = record.name;
      try {
        const snapshot = await readProjectSecrets(
          id,
          project.activeEnvironment,
          projectEnvironment.providerEnvironment,
          project.providerInstanceId,
          providerInstanceRepo,
          keychain,
          cache,
        );
        remote = snapshot.value;
        lastFetchTime = snapshot.fetchedAt;
        providerHealthy = true;
      } catch (err: unknown) {
        providerHealthy = false;
        providerError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  let staged: StagingSummary | null;
  if (desired === undefined) {
    staged = { added: 0, modified: 0, deleted: 0, total: 0 };
  } else if (remote === undefined) {
    staged = null;
  } else {
    staged = summarizeStaging(
      toSecretDiffKeys(diffSecrets(remote, stagedDesiredToSecretMap(desired))),
    );
  }

  writeJson(res, 200, {
    providerInstanceId: project.providerInstanceId,
    provider,
    providerInstanceName,
    providerHealthy,
    providerError,
    lastFetchTime,
    staged,
  });
}

function parseProjectPullBody(body: unknown): {
  force: boolean;
  environment?: string;
} {
  if (!isRecord(body)) {
    throw new EnvdError("request body must be a JSON object", {
      code: "usage_error",
    });
  }

  const force = body["force"];
  if (force !== undefined && typeof force !== "boolean") {
    throw new EnvdError("force must be a boolean", {
      code: "usage_error",
    });
  }

  const environment = environmentFromBody(body);
  return {
    force: force === true,
    ...(environment === undefined ? {} : { environment }),
  };
}

interface ParsedProjectCommitBody {
  readonly message?: string;
  readonly strategy: "abort" | "theirs" | "ours";
  readonly environment?: string;
}

function parseProjectCommitBody(body: unknown): ParsedProjectCommitBody {
  if (!isRecord(body)) {
    throw new EnvdError("request body must be a JSON object", {
      code: "usage_error",
    });
  }

  const message = body["message"];
  if (message !== undefined && typeof message !== "string") {
    throw new EnvdError("message must be a string when provided", {
      code: "usage_error",
    });
  }
  const parsedMessage = typeof message === "string" ? message : undefined;

  const environment = environmentFromBody(body);
  const strategy = body["strategy"];
  if (strategy === undefined) {
    return {
      ...(parsedMessage === undefined ? {} : { message: parsedMessage }),
      ...(environment === undefined ? {} : { environment }),
      strategy: "abort",
    };
  }
  if (strategy !== "abort" && strategy !== "theirs" && strategy !== "ours") {
    throw new EnvdError("strategy must be one of abort, theirs, or ours", {
      code: "usage_error",
    });
  }

  return {
    ...(parsedMessage === undefined ? {} : { message: parsedMessage }),
    ...(environment === undefined ? {} : { environment }),
    strategy,
  };
}

function parseSecretMap(value: unknown): SecretMap {
  if (!isRecord(value)) {
    throw new EnvdError("values must be an object", { code: "usage_error" });
  }
  const map: Record<string, string> = {};
  for (const [key, secretValue] of Object.entries(value)) {
    if (typeof secretValue !== "string") {
      throw new EnvdError("values must contain only string values", {
        code: "usage_error",
        details: { key },
      });
    }
    map[key] = secretValue;
  }
  return map;
}

interface ParsedProjectImportBody {
  readonly environment: string;
  readonly values: SecretMap;
}

function parseProjectImportBody(body: unknown): ParsedProjectImportBody {
  if (!isRecord(body)) {
    throw new EnvdError("request body must be a JSON object", {
      code: "usage_error",
    });
  }
  const environment = environmentFromBody(body);
  if (environment === undefined) {
    throw new EnvdError("environment is required", { code: "usage_error" });
  }
  return {
    environment,
    values: parseSecretMap(body["values"]),
  };
}

function secretValue(map: SecretMap, key: string): string | null {
  return Object.prototype.hasOwnProperty.call(map, key)
    ? (map[key] ?? null)
    : null;
}

interface CommitConflictEntry {
  readonly key: string;
  readonly base: string | null;
  readonly remote: string | null;
  readonly desired: string | null;
}

function findCommitConflicts(
  base: SecretMap,
  remote: SecretMap,
  desired: SecretMap,
): readonly CommitConflictEntry[] {
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(remote),
    ...Object.keys(desired),
  ]);
  const conflicts: CommitConflictEntry[] = [];

  for (const key of [...keys].sort()) {
    const baseValue = secretValue(base, key);
    const remoteValue = secretValue(remote, key);
    const desiredValue = secretValue(desired, key);
    const localChanged = desiredValue !== baseValue;
    const remoteChanged = remoteValue !== baseValue;
    if (localChanged && remoteChanged && desiredValue !== remoteValue) {
      conflicts.push({
        key,
        base: baseValue,
        remote: remoteValue,
        desired: desiredValue,
      });
    }
  }

  return conflicts;
}

function applyTheirsStrategy(
  desired: SecretMap,
  conflicts: readonly CommitConflictEntry[],
): SecretMap {
  const resolved: Record<string, string> = { ...desired };
  for (const conflict of conflicts) {
    if (conflict.remote === null) {
      delete resolved[conflict.key];
    } else {
      resolved[conflict.key] = conflict.remote;
    }
  }
  return resolved;
}

function toChangeSet(remote: SecretMap, desired: SecretMap): ChangeSet {
  const diff = diffSecrets(remote, desired);
  const upserts: Record<string, string> = { ...diff.added };
  for (const [key, value] of Object.entries(diff.modified)) {
    upserts[key] = value.after;
  }
  return {
    upserts,
    deletes: Object.keys(diff.deleted).sort(),
  };
}

function isEmptyChangeSet(changes: ChangeSet): boolean {
  return (
    Object.keys(changes.upserts).length === 0 && changes.deletes.length === 0
  );
}

async function pushProjectChanges(
  projectId: string,
  providerEnvironment: string,
  providerInstanceId: string | null,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
  changes: ChangeSet,
): Promise<PushResult> {
  if (providerInstanceId === null) {
    throw new EnvdError("project has no provider instance", {
      code: "usage_error",
      details: { projectId },
    });
  }

  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const keychainAdapter = requireKeychain(keychain);
  const record = repo.get(providerInstanceId);
  if (record === undefined) {
    throw new EnvdError("provider instance not found", {
      code: "provider_unreachable",
      details: { providerInstanceId },
    });
  }

  const provider = findProvider(record.provider);
  if (provider === undefined) {
    throw new EnvdError("provider is not registered", {
      code: "usage_error",
      details: { provider: record.provider },
    });
  }

  try {
    const instance: ProviderInstance = await provider.create(
      providerContext(keychainAdapter, record.id, provider.name, {
        projectId,
        environment: providerEnvironment,
      }),
      environmentConfig(parseStoredConfig(record), providerEnvironment),
    );
    try {
      return await instance.push(changes);
    } finally {
      if (instance.close !== undefined) {
        await instance.close();
      }
    }
  } catch (err: unknown) {
    if (err instanceof EnvdError) {
      throw err;
    }
    throw new EnvdError("provider is unreachable", {
      code: "provider_unreachable",
      cause: err,
    });
  }
}

async function handlePullProject(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  stagingRepo: StagingRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
  id: string,
): Promise<void> {
  const projects = requireProjectRepo(projectRepo);
  const staging = requireStagingRepo(stagingRepo);
  const project = projects.get(id);
  if (project === undefined) {
    writeJsonError(res, 404, "not_found", "Project not found");
    return;
  }

  const input = parseProjectPullBody(await readJsonBody(req));
  const projectEnvironment = resolveProjectEnvironment(
    projects,
    project,
    input.environment,
  );
  const environment = projectEnvironment.name;
  const desired = staging.getDesired(id, environment);
  if (desired !== undefined && !input.force) {
    writeJsonError(
      res,
      409,
      "commit_conflict",
      "Project has staged changes; pass force=true to discard them",
      { projectId: id, stagedKeys: Object.keys(desired).sort() },
    );
    return;
  }

  staging.clear(id, environment);
  const snapshot = await refreshProjectSecrets(
    id,
    environment,
    projectEnvironment.providerEnvironment,
    project.providerInstanceId,
    providerInstanceRepo,
    keychain,
    cache,
  );
  writeJson(res, 200, { snapshotFetchedAt: snapshot.fetchedAt });
}

async function handleCommitProject(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  stagingRepo: StagingRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
  id: string,
): Promise<void> {
  const projects = requireProjectRepo(projectRepo);
  const staging = requireStagingRepo(stagingRepo);
  const project = projects.get(id);
  if (project === undefined) {
    writeJsonError(res, 404, "not_found", "Project not found");
    return;
  }

  const input = parseProjectCommitBody(await readJsonBody(req));
  const projectEnvironment = resolveProjectEnvironment(
    projects,
    project,
    input.environment,
  );
  const environment = projectEnvironment.name;
  const stagedDesired = staging.getDesired(id, environment);
  if (stagedDesired === undefined) {
    await refreshProjectSecrets(
      id,
      environment,
      projectEnvironment.providerEnvironment,
      project.providerInstanceId,
      providerInstanceRepo,
      keychain,
      cache,
    );
    writeJson(res, 200, {
      applied: { upserts: {}, deletes: [] },
      commitId: null,
    });
    return;
  }

  const desired = stagedDesiredToSecretMap(stagedDesired);
  const baseline = await readBaselineProjectSecrets(
    id,
    environment,
    projectEnvironment.providerEnvironment,
    project.providerInstanceId,
    providerInstanceRepo,
    keychain,
    cache,
  );
  const fresh = await refreshProjectSecrets(
    id,
    environment,
    projectEnvironment.providerEnvironment,
    project.providerInstanceId,
    providerInstanceRepo,
    keychain,
    cache,
  );

  const conflicts = findCommitConflicts(baseline.value, fresh.value, desired);
  if (conflicts.length > 0 && input.strategy === "abort") {
    writeJsonError(
      res,
      409,
      "commit_conflict",
      "Commit conflicts detected; retry with strategy='ours' or strategy='theirs'",
      {
        strategy: input.strategy,
        conflicts,
      },
    );
    return;
  }

  const finalDesired =
    input.strategy === "theirs"
      ? applyTheirsStrategy(desired, conflicts)
      : desired;
  const changes = toChangeSet(fresh.value, finalDesired);

  if (isEmptyChangeSet(changes)) {
    staging.clear(id, environment);
    cache.invalidate(scopedProjectKey(id, environment));
    writeJson(res, 200, { applied: changes, commitId: null });
    return;
  }

  const result = await pushProjectChanges(
    id,
    projectEnvironment.providerEnvironment,
    project.providerInstanceId,
    providerInstanceRepo,
    keychain,
    changes,
  );
  if (result.status === "conflict") {
    writeJsonError(
      res,
      409,
      "commit_conflict",
      "Provider reported a conflict while applying changes",
      {
        strategy: input.strategy,
        remote: result.remote,
      },
    );
    return;
  }

  staging.clear(id, environment);
  cache.invalidate(scopedProjectKey(id, environment));
  writeJson(res, 200, { applied: result.applied, commitId: null });
}

async function handleImportProjectEnvironment(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  stagingRepo: StagingRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
  id: string,
): Promise<void> {
  const projects = requireProjectRepo(projectRepo);
  const staging = requireStagingRepo(stagingRepo);
  const project = projects.get(id);
  if (project === undefined) {
    writeJsonError(res, 404, "not_found", "Project not found");
    return;
  }

  const input = parseProjectImportBody(await readJsonBody(req));
  const projectEnvironment = resolveProjectEnvironment(
    projects,
    project,
    input.environment,
  );
  const snapshot = await refreshProjectSecrets(
    id,
    projectEnvironment.name,
    projectEnvironment.providerEnvironment,
    project.providerInstanceId,
    providerInstanceRepo,
    keychain,
    cache,
  );
  const changes = toChangeSet(snapshot.value, input.values);
  if (!isEmptyChangeSet(changes)) {
    const result = await pushProjectChanges(
      id,
      projectEnvironment.providerEnvironment,
      project.providerInstanceId,
      providerInstanceRepo,
      keychain,
      changes,
    );
    if (result.status === "conflict") {
      writeJsonError(
        res,
        409,
        "commit_conflict",
        "Provider reported a conflict while importing values",
        { remote: result.remote },
      );
      return;
    }
  }

  const verified = await refreshProjectSecrets(
    id,
    projectEnvironment.name,
    projectEnvironment.providerEnvironment,
    project.providerInstanceId,
    providerInstanceRepo,
    keychain,
    cache,
  );
  for (const [key, value] of Object.entries(input.values)) {
    if (verified.value[key] !== value) {
      throw new EnvdError("provider import verification failed", {
        code: "provider_unreachable",
        details: { environment: projectEnvironment.name, key },
      });
    }
  }
  staging.clear(id, projectEnvironment.name);
  writeJson(res, 200, {
    environment: projectEnvironment.name,
    keyCount: Object.keys(input.values).length,
    verified: true,
  });
}

function handleDeleteProject(
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
  id: string,
): void {
  const repo = requireProjectRepo(projectRepo);
  repo.delete(id);
  res.writeHead(204);
  res.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function handleListProviders(res: ServerResponse): void {
  writeJson(res, 200, {
    providers: providers.map((provider) => ({
      name: provider.name,
      environmentMode: provider.environmentMode,
      instanceConfigSchema: provider.instanceConfigSchema,
      credentialKeys: provider.credentialKeys,
    })),
  });
}

interface ParsedCreateProviderInstanceBody {
  readonly provider: Provider;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly credentials: Record<string, string>;
}

function parseCredentials(
  body: Record<string, unknown>,
  provider: Provider,
): Record<string, string> {
  const rawCredentials =
    "credentials" in body ? body["credentials"] : Object.freeze({});
  if (!isRecord(rawCredentials)) {
    throw new EnvdError("credentials must be a JSON object", {
      code: "usage_error",
    });
  }

  const allowedKeys = new Set(provider.credentialKeys);
  for (const key of Object.keys(rawCredentials)) {
    if (!allowedKeys.has(key)) {
      throw new EnvdError("credentials include an unknown key", {
        code: "usage_error",
        details: { key },
      });
    }
  }

  const credentials: Record<string, string> = {};
  for (const key of provider.credentialKeys) {
    const value = rawCredentials[key];
    if (typeof value !== "string") {
      throw new EnvdError("credentials must include string values", {
        code: "usage_error",
        details: { key },
      });
    }
    credentials[key] = value;
  }
  return credentials;
}

function parseCreateProviderInstanceBody(
  body: unknown,
): ParsedCreateProviderInstanceBody {
  if (!isRecord(body)) {
    throw new EnvdError("request body must be a JSON object", {
      code: "usage_error",
    });
  }

  const providerName = body["provider"];
  if (typeof providerName !== "string" || providerName === "") {
    throw new EnvdError("provider must be a non-empty string", {
      code: "usage_error",
    });
  }

  const provider = findProvider(providerName);
  if (provider === undefined) {
    throw new EnvdError("provider is not registered", {
      code: "usage_error",
      details: { provider: providerName },
    });
  }

  const name = body["name"];
  if (typeof name !== "string" || name === "") {
    throw new EnvdError("name must be a non-empty string", {
      code: "usage_error",
    });
  }

  const config = "config" in body ? body["config"] : {};
  if (!isRecord(config)) {
    throw new EnvdError("config must be a JSON object", {
      code: "usage_error",
    });
  }

  return {
    provider,
    name,
    config,
    credentials: parseCredentials(body, provider),
  };
}

function parseStoredConfig(record: ProviderInstanceRecord): unknown {
  try {
    return JSON.parse(record.config) as unknown;
  } catch (err: unknown) {
    throw new EnvdError("provider instance config is malformed", {
      code: "internal",
      details: { providerInstanceId: record.id },
      cause: err,
    });
  }
}

function providerInstanceResponse(
  record: ProviderInstanceRecord,
): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    name: record.name,
    config: parseStoredConfig(record),
    createdAt: record.createdAt,
  };
}

function scopedKeychain(
  keychain: KeychainAdapter,
  providerInstanceId: string,
): KeychainAdapter {
  return {
    set(_service, account, secret) {
      return keychain.set(providerInstanceId, account, secret);
    },
    get(_service, account) {
      return keychain.get(providerInstanceId, account);
    },
    delete(_service, account) {
      return keychain.delete(providerInstanceId, account);
    },
  };
}

function providerContext(
  keychain: KeychainAdapter,
  providerInstanceId: string,
  providerName: string,
  scope?: { readonly projectId: string; readonly environment: string },
): ProviderContext {
  return {
    keychain: scopedKeychain(keychain, providerInstanceId),
    logger: createLogger(`providers/${providerName}`),
    fetch: globalThis.fetch,
    ...(scope === undefined ? {} : scope),
  };
}

async function storeCredentials(
  keychain: KeychainAdapter,
  providerInstanceId: string,
  provider: Provider,
  credentials: Record<string, string>,
): Promise<void> {
  for (const key of provider.credentialKeys) {
    const value = credentials[key];
    if (value === undefined) {
      throw new EnvdError("credential is missing", {
        code: "usage_error",
        details: { key },
      });
    }
    await keychain.set(providerInstanceId, key, value);
  }
}

async function deleteCredentials(
  keychain: KeychainAdapter,
  providerInstanceId: string,
  provider: Provider,
): Promise<void> {
  for (const key of provider.credentialKeys) {
    await keychain.delete(providerInstanceId, key);
  }
}

async function validateProviderInstanceConfig(
  provider: Provider,
  providerInstanceId: string,
  keychain: KeychainAdapter,
  config: unknown,
): Promise<void> {
  const instance = await provider.create(
    providerContext(keychain, providerInstanceId, provider.name),
    config,
  );
  if (instance.close !== undefined) {
    await instance.close();
  }
}

async function cleanupCreatedProviderInstance(
  repo: ProviderInstanceRepo,
  keychain: KeychainAdapter,
  record: ProviderInstanceRecord,
  provider: Provider,
): Promise<void> {
  try {
    repo.delete(record.id);
    await deleteCredentials(keychain, record.id, provider);
  } catch (err: unknown) {
    log.error({
      msg: "failed to clean up provider instance after create failure",
      data: { providerInstanceId: record.id, ...safeErrorLogData(err) },
    });
  }
}

async function handleCreateProviderInstance(
  req: IncomingMessage,
  res: ServerResponse,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
): Promise<void> {
  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const keychainAdapter = requireKeychain(keychain);
  const body = await readJsonBody(req);
  const input = parseCreateProviderInstanceBody(body);
  const record = repo.create({
    provider: input.provider.name,
    name: input.name,
    config: JSON.stringify(input.config),
  });

  try {
    await storeCredentials(
      keychainAdapter,
      record.id,
      input.provider,
      input.credentials,
    );
    await validateProviderInstanceConfig(
      input.provider,
      record.id,
      keychainAdapter,
      input.config,
    );
  } catch (err: unknown) {
    await cleanupCreatedProviderInstance(
      repo,
      keychainAdapter,
      record,
      input.provider,
    );
    throw err;
  }

  writeJson(res, 201, { id: record.id });
}

function handleListProviderInstances(
  res: ServerResponse,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
): void {
  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  writeJson(res, 200, {
    providerInstances: repo.list().map(providerInstanceResponse),
  });
}

function handleGetProviderInstance(
  res: ServerResponse,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  id: string,
): void {
  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const record = repo.get(id);
  if (record === undefined) {
    writeJsonError(res, 404, "not_found", "Provider instance not found");
    return;
  }
  writeJson(res, 200, providerInstanceResponse(record));
}

async function handleDeleteProviderInstance(
  res: ServerResponse,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
  id: string,
): Promise<void> {
  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const keychainAdapter = requireKeychain(keychain);
  const record = repo.get(id);
  if (record === undefined) {
    writeJsonError(res, 404, "not_found", "Provider instance not found");
    return;
  }

  const deleted = repo.delete(id);
  if (!deleted) {
    writeJsonError(res, 404, "not_found", "Provider instance not found");
    return;
  }

  const provider = findProvider(record.provider);
  if (provider !== undefined) {
    await deleteCredentials(keychainAdapter, id, provider);
  }

  res.writeHead(204);
  res.end();
}

async function handleTestProviderInstance(
  res: ServerResponse,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  keychain: KeychainAdapter | undefined,
  id: string,
): Promise<void> {
  const repo = requireProviderInstanceRepo(providerInstanceRepo);
  const keychainAdapter = requireKeychain(keychain);
  const record = repo.get(id);
  if (record === undefined) {
    writeJsonError(res, 404, "not_found", "Provider instance not found");
    return;
  }

  const provider = findProvider(record.provider);
  if (provider === undefined) {
    throw new EnvdError("provider is not registered", {
      code: "usage_error",
      details: { provider: record.provider },
    });
  }

  const instance = await provider.create(
    providerContext(keychainAdapter, id, provider.name),
    parseStoredConfig(record),
  );
  let result: { ok: true } | { ok: false; reason: string };
  try {
    result = await instance.test();
  } finally {
    if (instance.close !== undefined) {
      await instance.close();
    }
  }
  writeJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function parsePath(rawUrl: string | undefined): string {
  try {
    const u = new URL(rawUrl ?? "/", "http://localhost");
    return decodeURIComponent(u.pathname);
  } catch {
    return (rawUrl ?? "/").split("?")[0] ?? "/";
  }
}

function controlPathLabel(path: string): string {
  if (
    path === "/v1/health" ||
    path === "/v1/version" ||
    path === "/v1/shutdown" ||
    path === "/v1/logs" ||
    path === "/v1/projects" ||
    path === "/v1/providers" ||
    path === "/v1/provider-instances"
  ) {
    return path;
  }

  if (/^\/v1\/projects\/[^/]+$/.test(path)) {
    return "/v1/projects/:id";
  }

  const projectAction =
    /^\/v1\/projects\/[^/]+\/(diff|pull|commit|status)$/.exec(path);
  if (projectAction !== null) {
    return `/v1/projects/:id/${projectAction[1]}`;
  }

  if (/^\/v1\/provider-instances\/[^/]+$/.test(path)) {
    return "/v1/provider-instances/:id";
  }

  if (/^\/v1\/provider-instances\/[^/]+\/test$/.test(path)) {
    return "/v1/provider-instances/:id/test";
  }

  return "/v1/*";
}

type RouteKey = string; // "METHOD /path"

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function buildRoutes(onShutdown?: () => void): Map<RouteKey, Handler> {
  return new Map<RouteKey, Handler>([
    [
      "GET /v1/health",
      (_req, res) => {
        handleHealth(res);
      },
    ],
    [
      "GET /v1/version",
      (_req, res) => {
        handleVersion(res);
      },
    ],
    [
      "POST /v1/shutdown",
      (_req, res) => {
        handleShutdown(res, onShutdown);
      },
    ],
    [
      "GET /v1/providers",
      (_req, res) => {
        handleListProviders(res);
      },
    ],
  ]);
}

/** Set of paths the router knows about, used to distinguish 404 vs 405. */
const KNOWN_PATHS = new Set<string>([
  "/v1/health",
  "/v1/version",
  "/v1/shutdown",
  "/v1/logs",
  "/v1/projects",
  "/v1/providers",
  "/v1/provider-instances",
]);

function dispatch(
  token: string,
  routes: Map<RouteKey, Handler>,
  projectRepo: ProjectRepo | undefined,
  providerInstanceRepo: ProviderInstanceRepo | undefined,
  stagingRepo: StagingRepo | undefined,
  keychain: KeychainAdapter | undefined,
  cache: Cache<SecretMap>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const method = req.method ?? "";
  const path = parsePath(req.url);

  log.debug({
    msg: "control request",
    data: { method, path: controlPathLabel(path) },
  });

  // Auth gate — all endpoints require a valid bearer token.
  if (!requireAuth(req, res, token)) {
    return;
  }

  const routeKey: RouteKey = `${method} ${path}`;
  const handler = routes.get(routeKey);

  if (handler !== undefined) {
    handler(req, res);
    return;
  }

  if (method === "GET" && path === "/v1/logs") {
    try {
      handleGetLogs(req, res);
    } catch (err: unknown) {
      writeErrorFromUnknown(res, err);
    }
    return;
  }

  if (method === "POST" && path === "/v1/provider-instances") {
    void handleCreateProviderInstance(
      req,
      res,
      providerInstanceRepo,
      keychain,
    ).catch((err: unknown) => {
      writeErrorFromUnknown(res, err);
    });
    return;
  }

  if (method === "GET" && path === "/v1/provider-instances") {
    try {
      handleListProviderInstances(res, providerInstanceRepo);
    } catch (err: unknown) {
      writeErrorFromUnknown(res, err);
    }
    return;
  }

  const providerTestMatch = /^\/v1\/provider-instances\/([^/]+)\/test$/.exec(
    path,
  );
  if (providerTestMatch !== null) {
    const providerInstanceId = providerTestMatch[1];
    if (providerInstanceId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    if (method === "POST") {
      void handleTestProviderInstance(
        res,
        providerInstanceRepo,
        keychain,
        providerInstanceId,
      ).catch((err: unknown) => {
        writeErrorFromUnknown(res, err);
      });
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const providerInstanceMatch = /^\/v1\/provider-instances\/([^/]+)$/.exec(
    path,
  );
  if (providerInstanceMatch !== null) {
    const providerInstanceId = providerInstanceMatch[1];
    if (providerInstanceId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    try {
      if (method === "GET") {
        handleGetProviderInstance(
          res,
          providerInstanceRepo,
          providerInstanceId,
        );
        return;
      }
      if (method === "DELETE") {
        void handleDeleteProviderInstance(
          res,
          providerInstanceRepo,
          keychain,
          providerInstanceId,
        ).catch((err: unknown) => {
          writeErrorFromUnknown(res, err);
        });
        return;
      }
    } catch (err: unknown) {
      writeErrorFromUnknown(res, err);
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  if (method === "POST" && path === "/v1/projects") {
    void handleCreateProject(req, res, projectRepo).catch((err: unknown) => {
      writeErrorFromUnknown(res, err);
    });
    return;
  }

  if (method === "GET" && path === "/v1/projects") {
    try {
      handleListProjects(res, projectRepo);
    } catch (err: unknown) {
      writeErrorFromUnknown(res, err);
    }
    return;
  }

  const projectDiffMatch = /^\/v1\/projects\/([^/]+)\/diff$/.exec(path);
  if (projectDiffMatch !== null) {
    const projectId = projectDiffMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    if (method === "GET") {
      void handleGetProjectDiff(
        req,
        res,
        projectRepo,
        providerInstanceRepo,
        stagingRepo,
        keychain,
        projectId,
      ).catch((err: unknown) => {
        writeErrorFromUnknown(res, err);
      });
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const projectStatusMatch = /^\/v1\/projects\/([^/]+)\/status$/.exec(path);
  if (projectStatusMatch !== null) {
    const projectId = projectStatusMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    if (method === "GET") {
      void handleGetProjectStatus(
        res,
        projectRepo,
        providerInstanceRepo,
        stagingRepo,
        keychain,
        cache,
        projectId,
      ).catch((err: unknown) => {
        writeErrorFromUnknown(res, err);
      });
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const projectEnvironmentsMatch =
    /^\/v1\/projects\/([^/]+)\/environments$/.exec(path);
  if (projectEnvironmentsMatch !== null) {
    const projectId = projectEnvironmentsMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    try {
      if (method === "GET") {
        handleListProjectEnvironments(res, projectRepo, projectId);
        return;
      }
      if (method === "POST") {
        void handleCreateProjectEnvironment(
          req,
          res,
          projectRepo,
          projectId,
        ).catch((err: unknown) => {
          writeErrorFromUnknown(res, err);
        });
        return;
      }
    } catch (err: unknown) {
      writeErrorFromUnknown(res, err);
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const projectActiveEnvironmentMatch =
    /^\/v1\/projects\/([^/]+)\/active-environment$/.exec(path);
  if (projectActiveEnvironmentMatch !== null) {
    const projectId = projectActiveEnvironmentMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    if (method === "POST") {
      void handleSetProjectActiveEnvironment(
        req,
        res,
        projectRepo,
        projectId,
      ).catch((err: unknown) => {
        writeErrorFromUnknown(res, err);
      });
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const projectImportMatch = /^\/v1\/projects\/([^/]+)\/import$/.exec(path);
  if (projectImportMatch !== null) {
    const projectId = projectImportMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    if (method === "POST") {
      void handleImportProjectEnvironment(
        req,
        res,
        projectRepo,
        providerInstanceRepo,
        stagingRepo,
        keychain,
        cache,
        projectId,
      ).catch((err: unknown) => {
        writeErrorFromUnknown(res, err);
      });
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const projectPullMatch = /^\/v1\/projects\/([^/]+)\/pull$/.exec(path);
  if (projectPullMatch !== null) {
    const projectId = projectPullMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    if (method === "POST") {
      void handlePullProject(
        req,
        res,
        projectRepo,
        providerInstanceRepo,
        stagingRepo,
        keychain,
        cache,
        projectId,
      ).catch((err: unknown) => {
        writeErrorFromUnknown(res, err);
      });
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const projectCommitMatch = /^\/v1\/projects\/([^/]+)\/commit$/.exec(path);
  if (projectCommitMatch !== null) {
    const projectId = projectCommitMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    if (method === "POST") {
      void handleCommitProject(
        req,
        res,
        projectRepo,
        providerInstanceRepo,
        stagingRepo,
        keychain,
        cache,
        projectId,
      ).catch((err: unknown) => {
        writeErrorFromUnknown(res, err);
      });
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  const projectMatch = /^\/v1\/projects\/([^/]+)$/.exec(path);
  if (projectMatch !== null) {
    const projectId = projectMatch[1];
    if (projectId === undefined) {
      writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
      return;
    }

    try {
      if (method === "GET") {
        handleGetProject(res, projectRepo, projectId);
        return;
      }
      if (method === "DELETE") {
        handleDeleteProject(res, projectRepo, projectId);
        return;
      }
    } catch (err: unknown) {
      writeErrorFromUnknown(res, err);
      return;
    }

    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  // Distinguish 404 (unknown path) from 405 (wrong method on a known path).
  if (KNOWN_PATHS.has(path)) {
    writeJsonError(
      res,
      405,
      "method_not_allowed",
      `Method ${method} not allowed on ${path}`,
    );
    return;
  }

  writeJsonError(res, 404, "not_found", `No route for ${method} ${path}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startControlServer(
  opts: ControlServerOpts,
): Promise<ControlServerHandle> {
  const bindPort = opts.port ?? 1910;
  const token = opts.token;
  const projectRepo = opts.projectRepo;
  const providerInstanceRepo = opts.providerInstanceRepo;
  const stagingRepo = opts.stagingRepo;
  const cache = opts.cache ?? createCache<SecretMap>();
  const keychain =
    opts.keychain ??
    (providerInstanceRepo === undefined ? undefined : createKeychainAdapter());
  const routes = buildRoutes(opts.onShutdown);

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      dispatch(
        token,
        routes,
        projectRepo,
        providerInstanceRepo,
        stagingRepo,
        keychain,
        cache,
        req,
        res,
      );
    });

    server.once("error", reject);

    server.listen(bindPort, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("Unexpected server address type"));
        return;
      }
      const port = addr.port;
      log.info({
        msg: "Control API server listening",
        data: { port, host: "127.0.0.1" },
      });

      resolve({
        port,
        close(): Promise<void> {
          return new Promise((res2, rej2) => {
            server.close((err) => {
              if (err !== undefined) {
                rej2(err);
              } else {
                res2();
              }
            });
          });
        },
      });
    });
  });
}

/** Generates a new random token (32-byte hex). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}
