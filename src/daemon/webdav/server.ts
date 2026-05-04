import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { createLogger } from "../../shared/logger.js";
import type { Project, ProjectRepo } from "../../core/project.js";

const log = createLogger("daemon/webdav");

export interface WebdavServerOpts {
  /** TCP port to bind. Pass 0 for an ephemeral port (tests). Default: 1911. */
  port?: number;
  projectRepo: ProjectRepo;
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

type ProjectPath =
  | { kind: "root" }
  | { kind: "projects-root" }
  | { kind: "project-dir"; id: string; token: string }
  | { kind: "project-env"; id: string; token: string }
  | { kind: "unknown" };

function renderProjectFile(project: Project): RenderedProjectFile {
  const text = `# d-env project ${project.id}\n# staged at: ${project.updatedAt}\n`;
  const bytes = Buffer.from(text, "utf-8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    lastModified: new Date(project.updatedAt).toUTCString(),
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

function fileProps(project: Project): string {
  const rendered = renderProjectFile(project);
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
    Allow: "OPTIONS, PROPFIND, GET, HEAD",
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

function handlePropfind(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  projectRepo: ProjectRepo,
): void {
  const depth = parseDepth(req);
  const parsedPath = parseProjectPath(path);

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
        body += davResponse(`${href}.env`, fileProps(project));
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
        fileProps(project),
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

function handleGet(
  res: ServerResponse,
  project: Project,
  sendBody: boolean,
): void {
  const rendered = renderProjectFile(project);
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
    Allow: "OPTIONS, PROPFIND, GET, HEAD",
    "Content-Length": "0",
  });
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
    // Malformed URL — fall back to raw value without query string
    return (rawUrl ?? "/").split("?")[0] ?? "/";
  }
}

function dispatch(
  projectRepo: ProjectRepo,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const method = req.method ?? "";
  // Normalize path: strip query string, decode %xx.
  const path = parsePath(req.url);

  log.debug({ msg: "webdav request", data: { method, path } });

  if (method === "OPTIONS") {
    // macOS probes both OPTIONS / and OPTIONS *
    handleOptions(res);
    return;
  }

  if (method === "PROPFIND") {
    handlePropfind(req, res, path, projectRepo);
    return;
  }

  if (method === "GET" || method === "HEAD") {
    const parsedPath = parseProjectPath(path);
    if (parsedPath.kind === "project-env") {
      const project = loadProject(projectRepo, parsedPath.id, parsedPath.token);
      if (project !== undefined) {
        handleGet(res, project, method === "GET");
        return;
      }
      handleNotFound(res);
    } else {
      handleNotFound(res);
    }
    return;
  }

  // PUT, LOCK, UNLOCK, DELETE, MKCOL — not implemented in US-1.1
  handleMethodNotAllowed(res);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startWebdavServer(
  opts: WebdavServerOpts,
): Promise<WebdavServerHandle> {
  const bindPort = opts.port ?? 1911;
  const projectRepo = opts.projectRepo;

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      dispatch(projectRepo, req, res);
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
