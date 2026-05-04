import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createLogger } from "../../shared/logger.js";
import { DEnvError, type ErrorCode } from "../../shared/errors.js";
import type { ProjectRepo } from "../../core/project.js";
import { mountPath } from "../../shared/paths.js";
import { readJsonBody } from "./body.js";

// createRequire is the stable way to load JSON in ESM without import assertions
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require("../../../package.json");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const PKG_VERSION = pkg.version as string;

const log = createLogger("daemon/control");

const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ControlServerOpts {
  /** TCP port to bind. Pass 0 for an ephemeral port (tests). Default: 1910. */
  port?: number;
  /**
   * Auth token. When provided, filesystem bootstrap is skipped — used by
   * tests to supply the token directly without touching ~/.d-env/.
   */
  token: string;
  /**
   * Called after the 204 response is flushed on POST /v1/shutdown.
   * If not provided, the endpoint returns 204 but takes no shutdown action
   * (useful for unit tests that don't want the process to exit).
   */
  onShutdown?: () => void;
  projectRepo?: ProjectRepo;
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
  if (err instanceof DEnvError) {
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
    throw new DEnvError("project registry is not available", {
      code: "internal",
    });
  }
  return projectRepo;
}

function projectMountPath(id: string, token: string): string {
  return `${mountPath()}/p/${id}.${token}/.env`;
}

function parseProjectCreateBody(body: unknown): { path: string } {
  if (body === null || typeof body !== "object" || !("path" in body)) {
    throw new DEnvError("request body must include path", {
      code: "usage_error",
    });
  }

  const path = (body as { path?: unknown }).path;
  if (typeof path !== "string" || path === "") {
    throw new DEnvError("path must be a non-empty string", {
      code: "usage_error",
    });
  }

  return { path };
}

async function handleCreateProject(
  req: IncomingMessage,
  res: ServerResponse,
  projectRepo: ProjectRepo | undefined,
): Promise<void> {
  const repo = requireProjectRepo(projectRepo);
  const body = await readJsonBody(req);
  const input = parseProjectCreateBody(body);
  const project = repo.create({ path: input.path });
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
  ]);
}

/** Set of paths the router knows about, used to distinguish 404 vs 405. */
const KNOWN_PATHS = new Set<string>([
  "/v1/health",
  "/v1/version",
  "/v1/shutdown",
  "/v1/projects",
]);

function dispatch(
  token: string,
  routes: Map<RouteKey, Handler>,
  projectRepo: ProjectRepo | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const method = req.method ?? "";
  const path = parsePath(req.url);

  log.debug({ msg: "control request", data: { method, path } });

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
  const routes = buildRoutes(opts.onShutdown);

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      dispatch(token, routes, projectRepo, req, res);
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
