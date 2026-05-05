import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { createLogger } from "../../shared/logger.js";
import { DEnvError } from "../../shared/errors.js";
import type { Project, ProjectRepo } from "../../core/project.js";
import { createCache, type Cache, type CacheResult } from "../../core/cache.js";
import type { StagingRepo } from "../../core/staging.js";
import type {
  ProviderInstanceRecord,
  ProviderInstanceRepo,
} from "../../core/provider-instance.js";
import { secretsKind, type FormatConfig } from "../../kinds/secrets/index.js";
import { findProvider } from "../../providers/registry.js";
import type {
  KeychainAdapter,
  Provider,
  ProviderContext,
  ProviderInstance,
  SecretMap,
} from "../../providers/base.js";
import { createKeychainAdapter } from "../../core/keychain.js";

const log = createLogger("daemon/webdav");
const DEFAULT_CACHE_TTL_MS = 60_000;
const ALLOW_HEADER = "OPTIONS, PROPFIND, GET, HEAD, PUT";

export interface WebdavServerOpts {
  /** TCP port to bind. Pass 0 for an ephemeral port (tests). Default: 1911. */
  port?: number;
  projectRepo: ProjectRepo;
  stagingRepo?: StagingRepo;
  providerInstanceRepo?: ProviderInstanceRepo;
  keychain?: KeychainAdapter;
  cache?: Cache<SecretMap>;
}

export interface WebdavServerHandle {
  /** The actual TCP port the server is listening on (useful when port=0). */
  port: number;
  /** Gracefully closes the HTTP server. */
  close(): Promise<void>;
}

interface RenderedProjectFile {
  bytes: Buffer;
  lastModified: string;
  etag: string;
}

interface WebdavRuntime {
  readonly projectRepo: ProjectRepo;
  readonly stagingRepo: StagingRepo | undefined;
  readonly providerInstanceRepo: ProviderInstanceRepo | undefined;
  readonly keychain: KeychainAdapter | undefined;
  readonly cache: Cache<SecretMap>;
}

type ProjectPath =
  | { kind: "root" }
  | { kind: "projects-root" }
  | { kind: "project-dir"; id: string; token: string }
  | { kind: "project-env"; id: string; token: string }
  | { kind: "unknown" };

class ProviderUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    throw new Error(`${label} is not valid JSON`, { cause: err });
  }
}

function parseProjectFormat(project: Project): FormatConfig {
  if (project.format !== "dotenv") {
    throw new Error(`unsupported project format: ${project.format}`);
  }

  const parsed = parseJson(project.formatConfig, "project formatConfig");
  if (!isRecord(parsed)) {
    throw new Error("project formatConfig must be a JSON object");
  }

  return {
    format: "dotenv",
    options: parsed,
  };
}

function parseProviderConfig(record: ProviderInstanceRecord): unknown {
  return parseJson(record.config, "provider instance config");
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
    throw new Error(
      "provider instance cache TTL must be a non-negative number",
    );
  }

  return raw;
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
): ProviderContext {
  return {
    keychain: scopedKeychain(keychain, providerInstanceId),
    logger: createLogger(`providers/${providerName}`),
    fetch: globalThis.fetch,
  };
}

async function fetchFromProvider(
  provider: Provider,
  keychain: KeychainAdapter,
  record: ProviderInstanceRecord,
  config: unknown,
): Promise<SecretMap> {
  const instance: ProviderInstance = await provider.create(
    providerContext(keychain, record.id, provider.name),
    config,
  );

  try {
    return await instance.fetch();
  } finally {
    if (instance.close !== undefined) {
      await instance.close();
    }
  }
}

async function readProviderSnapshot(
  runtime: WebdavRuntime,
  project: Project,
): Promise<CacheResult<SecretMap>> {
  try {
    if (project.providerInstanceId === null) {
      throw new Error("project has no provider instance");
    }

    if (runtime.providerInstanceRepo === undefined) {
      throw new Error("provider instance registry is not available");
    }

    const keychain = runtime.keychain;
    if (keychain === undefined) {
      throw new Error("keychain adapter is not available");
    }

    const record = runtime.providerInstanceRepo.get(project.providerInstanceId);
    if (record === undefined) {
      throw new Error("provider instance not found");
    }

    const provider = findProvider(record.provider);
    if (provider === undefined) {
      throw new Error("provider is not registered");
    }

    const config = parseProviderConfig(record);
    const ttlMs = readCacheTtlMs(config);
    return await runtime.cache.get(
      project.id,
      () => fetchFromProvider(provider, keychain, record, config),
      { ttlMs },
    );
  } catch (err: unknown) {
    throw new ProviderUnavailableError("provider is unreachable", {
      cause: err,
    });
  }
}

async function renderProjectFile(
  runtime: WebdavRuntime,
  project: Project,
): Promise<RenderedProjectFile> {
  const format = parseProjectFormat(project);
  const snapshot = await readProviderSnapshot(runtime, project);
  const bytes = Buffer.from(secretsKind.render(snapshot.value, format));
  const hash = createHash("sha256").update(bytes).digest("hex");

  return {
    bytes,
    lastModified: new Date(snapshot.fetchedAt).toUTCString(),
    etag: `"${hash}"`,
  };
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** Wraps an href + propstat pair in a DAV:response element. */
function davResponse(href: string, props: string): string {
  return `  <D:response>\n    <D:href>${href}</D:href>\n${props}  </D:response>\n`;
}

function davPropstat(prop: string, status = "HTTP/1.1 200 OK"): string {
  return `    <D:propstat>\n      <D:prop>\n${prop}      </D:prop>\n      <D:status>${status}</D:status>\n    </D:propstat>\n`;
}

/** Returns multistatus XML for a directory resource. */
function collectionProps(displayName: string): string {
  return davPropstat(
    `        <D:resourcetype><D:collection/></D:resourcetype>\n        <D:displayname>${displayName}</D:displayname>\n`,
  );
}

async function fileProps(
  runtime: WebdavRuntime,
  project: Project,
): Promise<string> {
  const rendered = await renderProjectFile(runtime, project);
  return davPropstat(
    `        <D:resourcetype/>\n        <D:displayname>.env</D:displayname>\n        <D:getcontenttype>text/plain; charset=utf-8</D:getcontenttype>\n        <D:getcontentlength>${rendered.bytes.length}</D:getcontentlength>\n        <D:getlastmodified>${rendered.lastModified}</D:getlastmodified>\n        <D:getetag>${rendered.etag}</D:getetag>\n`,
  );
}

function multistatus(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:multistatus xmlns:D="DAV:">\n${body}</D:multistatus>`
  );
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

function handleOptions(res: ServerResponse): void {
  res.writeHead(200, {
    DAV: "1, 2",
    Allow: ALLOW_HEADER,
    "MS-Author-Via": "DAV",
    "Content-Length": "0",
  });
  res.end();
}

function parseDepth(req: IncomingMessage): number {
  const raw = req.headers["depth"];
  if (raw === "0") return 0;
  // Treat "1", "infinity", or missing as 1 for our purposes.
  return 1;
}

function parseProjectPath(path: string): ProjectPath {
  if (path === "/" || path === "") {
    return { kind: "root" };
  }

  if (path === "/p" || path === "/p/") {
    return { kind: "projects-root" };
  }

  const projectMatch = /^\/p\/([^/.]+)\.([^/]+)\/?$/.exec(path);
  if (projectMatch !== null) {
    const id = projectMatch[1];
    const token = projectMatch[2];
    if (id !== undefined && token !== undefined) {
      return { kind: "project-dir", id, token };
    }
  }

  const envMatch = /^\/p\/([^/.]+)\.([^/]+)\/\.env$/.exec(path);
  if (envMatch !== null) {
    const id = envMatch[1];
    const token = envMatch[2];
    if (id !== undefined && token !== undefined) {
      return { kind: "project-env", id, token };
    }
  }

  return { kind: "unknown" };
}

function loadProject(
  projectRepo: ProjectRepo,
  id: string,
  token: string,
): Project | undefined {
  return projectRepo.getByToken(id, token);
}

async function handlePropfind(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  runtime: WebdavRuntime,
): Promise<void> {
  const depth = parseDepth(req);
  const parsedPath = parseProjectPath(path);
  const projectRepo = runtime.projectRepo;

  let body = "";

  switch (parsedPath.kind) {
    case "root":
      body += davResponse("/", collectionProps("d-env"));
      if (depth >= 1) {
        body += davResponse("/p/", collectionProps("p"));
      }
      break;
    case "projects-root":
      body += davResponse("/p/", collectionProps("p"));
      if (depth >= 1) {
        for (const project of projectRepo.list()) {
          body += davResponse(
            `/p/${project.id}.${project.token}/`,
            collectionProps(`${project.id}.${project.token}`),
          );
        }
      }
      break;
    case "project-dir": {
      const project = loadProject(projectRepo, parsedPath.id, parsedPath.token);
      if (project === undefined) {
        res.writeHead(404, { "Content-Length": "0" });
        res.end();
        return;
      }
      const href = `/p/${project.id}.${project.token}/`;
      body += davResponse(
        href,
        collectionProps(`${project.id}.${project.token}`),
      );
      if (depth >= 1) {
        body += davResponse(`${href}.env`, await fileProps(runtime, project));
      }
      break;
    }
    case "project-env": {
      const project = loadProject(projectRepo, parsedPath.id, parsedPath.token);
      if (project === undefined) {
        res.writeHead(404, { "Content-Length": "0" });
        res.end();
        return;
      }
      body += davResponse(
        `/p/${project.id}.${project.token}/.env`,
        await fileProps(runtime, project),
      );
      break;
    }
    case "unknown":
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return;
  }

  const xml = multistatus(body);
  const xmlBuf = Buffer.from(xml, "utf-8");
  res.writeHead(207, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Length": xmlBuf.length,
  });
  res.end(xmlBuf);
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: WebdavRuntime,
  project: Project,
  sendBody: boolean,
): Promise<void> {
  const rendered = await renderProjectFile(runtime, project);

  if (ifNoneMatchMatches(req.headers["if-none-match"], rendered.etag)) {
    res.writeHead(304, {
      "Last-Modified": rendered.lastModified,
      ETag: rendered.etag,
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": rendered.bytes.length,
    "Last-Modified": rendered.lastModified,
    ETag: rendered.etag,
  });
  if (sendBody) {
    res.end(rendered.bytes);
  } else {
    res.end();
  }
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("error", reject);

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

async function handlePut(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: WebdavRuntime,
  project: Project,
): Promise<void> {
  const stagingRepo = runtime.stagingRepo;
  if (stagingRepo === undefined) {
    throw new Error("staging registry is not available");
  }

  const bytes = await readRequestBody(req);
  const desired = secretsKind.parse(bytes, parseProjectFormat(project));
  stagingRepo.setDesired(project.id, desired);
  res.writeHead(204, { "Content-Length": "0" });
  res.end();
}

function ifNoneMatchMatches(
  rawHeader: string | string[] | undefined,
  etag: string,
): boolean {
  if (rawHeader === undefined) {
    return false;
  }

  const candidates = Array.isArray(rawHeader)
    ? rawHeader.flatMap((value) => value.split(","))
    : rawHeader.split(",");

  return candidates.some((candidate) => {
    const trimmed = candidate.trim();
    const normalized = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
    return normalized === "*" || normalized === etag;
  });
}

function handleNotFound(res: ServerResponse): void {
  const body = Buffer.from("Not Found", "utf-8");
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function handleMethodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, {
    Allow: ALLOW_HEADER,
    "Content-Length": "0",
  });
  res.end();
}

function handleBadDotenv(res: ServerResponse, err: unknown): void {
  log.warn({
    msg: "webdav dotenv parse failed",
    data: { error: String(err) },
  });

  const body = Buffer.from("Bad .env", "utf-8");
  res.writeHead(400, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "X-DEnv-Error": "bad_dotenv",
  });
  res.end(body);
}

function handleProviderUnavailable(res: ServerResponse, err: unknown): void {
  log.warn({
    msg: "webdav provider read failed",
    data: { error: String(err) },
  });

  const body = Buffer.from("Provider Unreachable", "utf-8");
  res.writeHead(503, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "X-DEnv-Error": "provider_unreachable",
  });
  res.end(body);
}

function handleInternalError(res: ServerResponse, err: unknown): void {
  log.error({
    msg: "webdav internal error",
    data: { error: String(err) },
  });

  const body = Buffer.from("Internal Server Error", "utf-8");
  res.writeHead(500, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "X-DEnv-Error": "internal",
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function parsePath(rawUrl: string | undefined): string {
  try {
    const u = new URL(rawUrl ?? "/", "http://localhost");
    return decodeURIComponent(u.pathname);
  } catch {
    // Malformed URL — fall back to raw value without query string
    return (rawUrl ?? "/").split("?")[0] ?? "/";
  }
}

async function dispatch(
  runtime: WebdavRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "";
  // Normalize path: strip query string, decode %xx.
  const path = parsePath(req.url);
  const projectRepo = runtime.projectRepo;

  log.debug({ msg: "webdav request", data: { method, path } });

  if (method === "OPTIONS") {
    // macOS probes both OPTIONS / and OPTIONS *
    handleOptions(res);
    return;
  }

  if (method === "PROPFIND") {
    try {
      await handlePropfind(req, res, path, runtime);
    } catch (err: unknown) {
      if (err instanceof ProviderUnavailableError) {
        handleProviderUnavailable(res, err);
      } else {
        handleInternalError(res, err);
      }
    }
    return;
  }

  if (method === "PUT") {
    const parsedPath = parseProjectPath(path);
    if (parsedPath.kind === "project-env") {
      const project = loadProject(projectRepo, parsedPath.id, parsedPath.token);
      if (project !== undefined) {
        try {
          await handlePut(req, res, runtime, project);
        } catch (err: unknown) {
          if (err instanceof DEnvError && err.code === "bad_dotenv") {
            handleBadDotenv(res, err);
          } else {
            handleInternalError(res, err);
          }
        }
        return;
      }
      handleNotFound(res);
    } else {
      handleNotFound(res);
    }
    return;
  }

  if (method === "GET" || method === "HEAD") {
    const parsedPath = parseProjectPath(path);
    if (parsedPath.kind === "project-env") {
      const project = loadProject(projectRepo, parsedPath.id, parsedPath.token);
      if (project !== undefined) {
        try {
          await handleGet(req, res, runtime, project, method === "GET");
        } catch (err: unknown) {
          if (err instanceof ProviderUnavailableError) {
            handleProviderUnavailable(res, err);
          } else {
            handleInternalError(res, err);
          }
        }
        return;
      }
      handleNotFound(res);
    } else {
      handleNotFound(res);
    }
    return;
  }

  // LOCK, UNLOCK, DELETE, MKCOL — not implemented.
  handleMethodNotAllowed(res);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startWebdavServer(
  opts: WebdavServerOpts,
): Promise<WebdavServerHandle> {
  const bindPort = opts.port ?? 1911;
  const runtime: WebdavRuntime = {
    projectRepo: opts.projectRepo,
    stagingRepo: opts.stagingRepo,
    providerInstanceRepo: opts.providerInstanceRepo,
    keychain:
      opts.keychain ??
      (opts.providerInstanceRepo === undefined
        ? undefined
        : createKeychainAdapter()),
    cache: opts.cache ?? createCache<SecretMap>(),
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      void dispatch(runtime, req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          handleInternalError(res, err);
        } else {
          log.error({
            msg: "webdav request failed after headers were sent",
            data: { error: String(err) },
          });
          res.destroy(err instanceof Error ? err : undefined);
        }
      });
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
        msg: "WebDAV server listening",
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
