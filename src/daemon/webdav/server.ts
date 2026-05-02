import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:http";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("daemon/webdav");

/** Content of the single hardcoded file served in US-1.1. */
const FILE_CONTENT = "HELLO=world\n";
const FILE_BYTES = Buffer.from(FILE_CONTENT, "utf-8");

export interface WebdavServerOpts {
  /** TCP port to bind. Pass 0 for an ephemeral port (tests). Default: 1911. */
  port?: number;
}

export interface WebdavServerHandle {
  /** The actual TCP port the server is listening on (useful when port=0). */
  port: number;
  /** Gracefully closes the HTTP server. */
  close(): Promise<void>;
}

// Fixed-per-server-start timestamp so macOS mount_webdav does not retry.
// Computed once at module init; stays stable for the life of the process.
const SERVER_START_TIME = new Date();
const LAST_MODIFIED = SERVER_START_TIME.toUTCString();
const ETAG = `"denv-hello-${SERVER_START_TIME.getTime()}"`;

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

/** Returns multistatus XML for /hello/.env. */
function fileProps(): string {
  const size = FILE_BYTES.length;
  return davPropstat(
    `        <D:resourcetype/>\n        <D:displayname>.env</D:displayname>\n        <D:getcontenttype>text/plain; charset=utf-8</D:getcontenttype>\n        <D:getcontentlength>${size}</D:getcontentlength>\n        <D:getlastmodified>${LAST_MODIFIED}</D:getlastmodified>\n        <D:getetag>${ETAG}</D:getetag>\n`,
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

function handlePropfind(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): void {
  const depth = parseDepth(req);

  let body = "";

  if (path === "/" || path === "") {
    // Root collection
    body += davResponse("/", collectionProps("d-env"));
    if (depth >= 1) {
      body += davResponse("/hello/", collectionProps("hello"));
    }
  } else if (path === "/hello" || path === "/hello/") {
    // /hello/ collection
    body += davResponse("/hello/", collectionProps("hello"));
    if (depth >= 1) {
      body += davResponse("/hello/.env", fileProps());
    }
  } else if (path === "/hello/.env") {
    body += davResponse("/hello/.env", fileProps());
  } else {
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

function handleGet(res: ServerResponse, sendBody: boolean): void {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": FILE_BYTES.length,
    "Last-Modified": LAST_MODIFIED,
    ETag: ETAG,
  });
  if (sendBody) {
    res.end(FILE_BYTES);
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

function dispatch(req: IncomingMessage, res: ServerResponse): void {
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
    handlePropfind(req, res, path);
    return;
  }

  if (method === "GET" || method === "HEAD") {
    if (path === "/hello/.env") {
      handleGet(res, method === "GET");
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
  opts: WebdavServerOpts = {},
): Promise<WebdavServerHandle> {
  const bindPort = opts.port ?? 1911;

  return new Promise((resolve, reject) => {
    const server: Server = createServer(dispatch);

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
