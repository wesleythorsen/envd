import { readFileSync } from "node:fs";
import { fetch } from "undici";
import { DEnvError } from "../shared/errors.js";
import * as paths from "../shared/paths.js";
import type { JSONSchema } from "../providers/base.js";
import type { SecretDiff, SecretDiffKeys } from "../kinds/secrets/diff.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ControlClient {
  health(): Promise<{ ok: boolean; version: string; uptimeSec: number }>;
  version(): Promise<{
    cli: string | null;
    daemon: string;
    protocol: string;
  }>;
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  getProject(id: string): Promise<ProjectDetail>;
  getProjectDiff(
    id: string,
    opts?: ProjectDiffOptions,
  ): Promise<ProjectDiffResult>;
  pullProject(
    id: string,
    opts?: ProjectPullOptions,
  ): Promise<ProjectPullResult>;
  deleteProject(id: string): Promise<void>;
  listProviders(): Promise<readonly ProviderMetadata[]>;
  createProviderInstance(
    input: CreateProviderInstanceInput,
  ): Promise<CreateProviderInstanceResult>;
  listProviderInstances(): Promise<readonly ProviderInstanceDetail[]>;
  getProviderInstance(id: string): Promise<ProviderInstanceDetail>;
  deleteProviderInstance(id: string): Promise<void>;
  testProviderInstance(id: string): Promise<ProviderTestResult>;
  /**
   * Calls POST /v1/shutdown. Treats 204 as success.
   * ECONNREFUSED after the call is also treated as success — the daemon may
   * close its socket as part of shutdown before our read completes.
   */
  shutdown(): Promise<void>;
}

export interface CreateProjectInput {
  readonly path: string;
  readonly providerInstanceId?: string;
  readonly format?: string;
  readonly formatConfig?: string;
}

export interface CreateProjectResult {
  readonly id: string;
  readonly token: string;
  readonly mountPath: string;
}

export interface ProjectDetail {
  readonly id: string;
  readonly token: string;
  readonly path: string;
  readonly providerInstanceId: string | null;
  readonly format: string;
  readonly formatConfig: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly mountPath: string;
}

export interface ProjectDiffOptions {
  readonly values?: boolean;
}

export interface ProjectDiffResult {
  readonly keys: SecretDiffKeys;
  readonly values?: SecretDiff;
}

export interface ProjectPullOptions {
  readonly force?: boolean;
}

export interface ProjectPullResult {
  readonly snapshotFetchedAt: number;
}

export interface ProviderMetadata {
  readonly name: string;
  readonly instanceConfigSchema: JSONSchema;
  readonly credentialKeys: readonly string[];
}

export interface CreateProviderInstanceInput {
  readonly provider: string;
  readonly name: string;
  readonly config?: Record<string, unknown>;
  readonly credentials?: Record<string, string>;
}

export interface CreateProviderInstanceResult {
  readonly id: string;
}

export interface ProviderInstanceDetail {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly config: unknown;
  readonly createdAt: number;
}

export type ProviderTestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface ControlClientOpts {
  /** Override base URL (e.g. http://127.0.0.1:1910). Defaults to reading paths.portsFile(). */
  baseUrl?: string;
  /** Override bearer token. Defaults to reading paths.controlTokenFile(). */
  token?: string;
  /** Request timeout in ms. Default 2000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the base URL from opts or by reading the ports file written by the
 * daemon on startup. Format: { "control": <port>, "webdav": <port> }
 */
function resolveBaseUrl(opts: ControlClientOpts): string {
  if (opts.baseUrl !== undefined && opts.baseUrl !== "") {
    return opts.baseUrl.replace(/\/$/, "");
  }

  const portsPath = paths.portsFile();
  let raw: string;
  try {
    raw = readFileSync(portsPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DEnvError("daemon is not running (no ports file)", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    throw err;
  }

  // as-cast justified: JSON.parse returns unknown; we narrow below.
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const controlPort = parsed["control"];
  if (typeof controlPort !== "number") {
    throw new DEnvError(
      "ports file is malformed (missing numeric 'control' field)",
      { code: "daemon_unreachable" },
    );
  }
  return `http://127.0.0.1:${controlPort}`;
}

function resolveToken(opts: ControlClientOpts): string {
  if (opts.token !== undefined && opts.token !== "") {
    return opts.token;
  }

  const tokenPath = paths.controlTokenFile();
  try {
    return readFileSync(tokenPath, "utf-8").trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DEnvError("control token missing", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Checks whether an error from undici.fetch is a connection-refused /
 * network-level failure that should map to daemon_unreachable.
 */
function isConnRefused(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const codes = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"];
  // The top-level TypeError sometimes carries the code.
  if (codes.includes((err as NodeJS.ErrnoException).code ?? "")) {
    return true;
  }
  // undici wraps the real error in a cause chain.
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    if (codes.includes((cause as NodeJS.ErrnoException).code ?? "")) {
      return true;
    }
  }
  return false;
}

/**
 * Executes one fetch call with a timeout and standard auth header.
 * Handles error-mapping centrally so each method stays minimal.
 */
async function apiGet<T>(
  base: string,
  token: string,
  path: string,
  timeoutMs: number,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
  } catch (err: unknown) {
    // AbortController fired → timeout
    if (err instanceof Error && err.name === "AbortError") {
      throw new DEnvError("timeout", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    // Network-level failure
    if (isConnRefused(err)) {
      throw new DEnvError("daemon is not running (connection refused)", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    // as-cast justified: caller constrains T to the known response shape.
    return (await response.json()) as T;
  }

  // Non-2xx — try to parse the canonical error body.
  let errBody: unknown;
  try {
    errBody = await response.json();
  } catch {
    errBody = undefined;
  }

  // as-cast justified: errBody is unknown; after the guards it's safe to treat
  // it as the canonical error shape.
  const errObj =
    errBody !== null &&
    typeof errBody === "object" &&
    errBody !== null &&
    "error" in errBody
      ? (errBody as { error: { code?: unknown; message?: unknown } }).error
      : undefined;

  const code = typeof errObj?.code === "string" ? errObj.code : undefined;
  const msg =
    typeof errObj?.message === "string"
      ? errObj.message
      : `HTTP ${response.status} from ${path}`;

  if (response.status === 401) {
    throw new DEnvError(msg, { code: "unauthorized" });
  }

  // Best-effort: use the server's error code if it's a known ErrorCode,
  // otherwise fall back to "internal".
  const isKnownCode =
    code === "daemon_unreachable" ||
    code === "usage_error" ||
    code === "provider_unreachable" ||
    code === "provider_auth" ||
    code === "commit_conflict" ||
    code === "mount_failed" ||
    code === "not_initialized" ||
    code === "internal" ||
    code === "bad_dotenv" ||
    code === "unauthorized" ||
    code === "not_found" ||
    code === "method_not_allowed";
  const safeCode: import("../shared/errors.js").ErrorCode = isKnownCode
    ? code
    : "internal";

  throw new DEnvError(msg, { code: safeCode });
}

/**
 * Executes a POST with no request body and handles the response.
 * 204 returns void. Connection errors post-send are treated as success for
 * shutdown: the daemon may close the socket before we read the response.
 */
async function apiPost(
  base: string,
  token: string,
  path: string,
  timeoutMs: number,
  treatConnRefusedAsSuccess: boolean = false,
): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new DEnvError("timeout", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    if (isConnRefused(err)) {
      if (treatConnRefusedAsSuccess) {
        return; // Expected: daemon closed socket as part of shutdown.
      }
      throw new DEnvError("daemon is not running (connection refused)", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) {
    return;
  }

  // Non-204 — parse and throw.
  let errBody: unknown;
  try {
    errBody = await response.json();
  } catch {
    errBody = undefined;
  }

  const errObj =
    errBody !== null && typeof errBody === "object" && "error" in errBody
      ? (errBody as { error: { code?: unknown; message?: unknown } }).error
      : undefined;

  const code = typeof errObj?.code === "string" ? errObj.code : undefined;
  const msg =
    typeof errObj?.message === "string"
      ? errObj.message
      : `HTTP ${response.status} from ${path}`;

  if (response.status === 401) {
    throw new DEnvError(msg, { code: "unauthorized" });
  }

  const isKnownCode =
    code === "daemon_unreachable" ||
    code === "usage_error" ||
    code === "provider_unreachable" ||
    code === "provider_auth" ||
    code === "commit_conflict" ||
    code === "mount_failed" ||
    code === "not_initialized" ||
    code === "internal" ||
    code === "bad_dotenv" ||
    code === "unauthorized" ||
    code === "not_found" ||
    code === "method_not_allowed";
  const safeCode: import("../shared/errors.js").ErrorCode = isKnownCode
    ? code
    : "internal";

  throw new DEnvError(msg, { code: safeCode });
}

async function apiPostJson<T>(
  base: string,
  token: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new DEnvError("timeout", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    if (isConnRefused(err)) {
      throw new DEnvError("daemon is not running (connection refused)", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (response.ok) {
    return (await response.json()) as T;
  }

  let errBody: unknown;
  try {
    errBody = await response.json();
  } catch {
    errBody = undefined;
  }

  const errObj =
    errBody !== null && typeof errBody === "object" && "error" in errBody
      ? (errBody as { error: { code?: unknown; message?: unknown } }).error
      : undefined;

  const code = typeof errObj?.code === "string" ? errObj.code : undefined;
  const msg =
    typeof errObj?.message === "string"
      ? errObj.message
      : `HTTP ${response.status} from ${path}`;

  const isKnownCode =
    code === "daemon_unreachable" ||
    code === "usage_error" ||
    code === "provider_unreachable" ||
    code === "provider_auth" ||
    code === "commit_conflict" ||
    code === "mount_failed" ||
    code === "not_initialized" ||
    code === "internal" ||
    code === "bad_dotenv" ||
    code === "unauthorized" ||
    code === "not_found" ||
    code === "method_not_allowed";
  const safeCode: import("../shared/errors.js").ErrorCode = isKnownCode
    ? code
    : "internal";

  throw new DEnvError(msg, { code: safeCode });
}

async function apiDelete(
  base: string,
  token: string,
  path: string,
  timeoutMs: number,
): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new DEnvError("timeout", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    if (isConnRefused(err)) {
      throw new DEnvError("daemon is not running (connection refused)", {
        code: "daemon_unreachable",
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) {
    return;
  }

  let errBody: unknown;
  try {
    errBody = await response.json();
  } catch {
    errBody = undefined;
  }

  const errObj =
    errBody !== null && typeof errBody === "object" && "error" in errBody
      ? (errBody as { error: { code?: unknown; message?: unknown } }).error
      : undefined;

  const code = typeof errObj?.code === "string" ? errObj.code : undefined;
  const msg =
    typeof errObj?.message === "string"
      ? errObj.message
      : `HTTP ${response.status} from ${path}`;

  const isKnownCode =
    code === "daemon_unreachable" ||
    code === "usage_error" ||
    code === "provider_unreachable" ||
    code === "provider_auth" ||
    code === "commit_conflict" ||
    code === "mount_failed" ||
    code === "not_initialized" ||
    code === "internal" ||
    code === "bad_dotenv" ||
    code === "unauthorized" ||
    code === "not_found" ||
    code === "method_not_allowed";
  const safeCode: import("../shared/errors.js").ErrorCode = isKnownCode
    ? code
    : "internal";

  throw new DEnvError(msg, { code: safeCode });
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createControlClient(opts?: ControlClientOpts): ControlClient {
  const resolvedOpts: ControlClientOpts = opts ?? {};
  const base = resolveBaseUrl(resolvedOpts);
  const token = resolveToken(resolvedOpts);
  const timeoutMs = resolvedOpts.timeoutMs ?? 2000;

  return {
    async health() {
      return apiGet<{ ok: boolean; version: string; uptimeSec: number }>(
        base,
        token,
        "/v1/health",
        timeoutMs,
      );
    },

    async version() {
      return apiGet<{ cli: string | null; daemon: string; protocol: string }>(
        base,
        token,
        "/v1/version",
        timeoutMs,
      );
    },

    async createProject(input) {
      return apiPostJson<CreateProjectResult>(
        base,
        token,
        "/v1/projects",
        input,
        timeoutMs,
      );
    },

    async getProject(id) {
      return apiGet<ProjectDetail>(
        base,
        token,
        `/v1/projects/${encodeURIComponent(id)}`,
        timeoutMs,
      );
    },

    async getProjectDiff(id, opts) {
      const query = opts?.values === true ? "?values=true" : "";
      return apiGet<ProjectDiffResult>(
        base,
        token,
        `/v1/projects/${encodeURIComponent(id)}/diff${query}`,
        timeoutMs,
      );
    },

    async pullProject(id, opts) {
      return apiPostJson<ProjectPullResult>(
        base,
        token,
        `/v1/projects/${encodeURIComponent(id)}/pull`,
        opts?.force === true ? { force: true } : {},
        timeoutMs,
      );
    },

    async deleteProject(id) {
      return apiDelete(
        base,
        token,
        `/v1/projects/${encodeURIComponent(id)}`,
        timeoutMs,
      );
    },

    async listProviders() {
      const response = await apiGet<{
        providers: readonly ProviderMetadata[];
      }>(base, token, "/v1/providers", timeoutMs);
      return response.providers;
    },

    async createProviderInstance(input) {
      return apiPostJson<CreateProviderInstanceResult>(
        base,
        token,
        "/v1/provider-instances",
        input,
        timeoutMs,
      );
    },

    async listProviderInstances() {
      const response = await apiGet<{
        providerInstances: readonly ProviderInstanceDetail[];
      }>(base, token, "/v1/provider-instances", timeoutMs);
      return response.providerInstances;
    },

    async getProviderInstance(id) {
      return apiGet<ProviderInstanceDetail>(
        base,
        token,
        `/v1/provider-instances/${encodeURIComponent(id)}`,
        timeoutMs,
      );
    },

    async deleteProviderInstance(id) {
      return apiDelete(
        base,
        token,
        `/v1/provider-instances/${encodeURIComponent(id)}`,
        timeoutMs,
      );
    },

    async testProviderInstance(id) {
      return apiPostJson<ProviderTestResult>(
        base,
        token,
        `/v1/provider-instances/${encodeURIComponent(id)}/test`,
        {},
        timeoutMs,
      );
    },

    async shutdown() {
      return apiPost(base, token, "/v1/shutdown", timeoutMs, true);
    },
  };
}
