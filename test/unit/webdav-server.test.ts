import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "undici";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startWebdavServer,
  type WebdavServerHandle,
} from "../../src/daemon/webdav/server.js";
import { openState, type StateStore } from "../../src/core/state.js";
import { ProjectRepo, type Project } from "../../src/core/project.js";

let server: WebdavServerHandle;
let base: string;
let state: StateStore;
let tempDir: string;
let project: Project;
let projectHref: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "d-env-webdav-test-"));
  const projectPath = join(tempDir, "project");
  mkdirSync(projectPath);
  state = openState(join(tempDir, "state.db"));
  const projectRepo = new ProjectRepo(state.db);
  project = projectRepo.create({ path: projectPath });
  projectHref = `/p/${project.id}.${project.token}`;
  server = await startWebdavServer({ port: 0, projectRepo });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  state.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// OPTIONS
// ---------------------------------------------------------------------------

describe("OPTIONS /", () => {
  it("returns DAV: 1, 2 and Allow header", async () => {
    const res = await request(`${base}/`, { method: "OPTIONS" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["dav"]).toBe("1, 2");
    expect(res.headers["allow"]).toContain("OPTIONS");
    expect(res.headers["allow"]).toContain("PROPFIND");
    expect(res.headers["allow"]).toContain("GET");
    expect(res.headers["allow"]).toContain("HEAD");
    expect(res.headers["ms-author-via"]).toBe("DAV");
    await res.body.dump();
  });

  it("OPTIONS * also returns WebDAV headers (macOS probe)", async () => {
    // node:http will route OPTIONS * as a path of "*"
    const res = await request(`${base}/*`, { method: "OPTIONS" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["dav"]).toBe("1, 2");
    await res.body.dump();
  });
});

// ---------------------------------------------------------------------------
// PROPFIND
// ---------------------------------------------------------------------------

describe("PROPFIND /", () => {
  it("depth 0 returns multistatus with root collection only", async () => {
    const res = await request(`${base}/`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:multistatus");
    expect(xml).toContain("<D:href>/</D:href>");
    expect(xml).toContain("<D:collection");
    expect(xml).not.toContain("/p/");
  });

  it("depth 1 returns root + /p/ child", async () => {
    const res = await request(`${base}/`, {
      method: "PROPFIND",
      headers: { depth: "1" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:href>/</D:href>");
    expect(xml).toContain("<D:href>/p/</D:href>");
  });
});

describe("PROPFIND /p/", () => {
  it("depth 0 returns /p/ collection", async () => {
    const res = await request(`${base}/p/`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:href>/p/</D:href>");
    expect(xml).not.toContain(`${projectHref}/`);
  });

  it("depth 1 lists project subpaths", async () => {
    const res = await request(`${base}/p/`, {
      method: "PROPFIND",
      headers: { depth: "1" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:href>/p/</D:href>");
    expect(xml).toContain(`<D:href>${projectHref}/</D:href>`);
  });
});

describe("PROPFIND project directory", () => {
  it("depth 0 returns the project collection", async () => {
    const res = await request(`${base}${projectHref}/`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain(`<D:href>${projectHref}/</D:href>`);
    expect(xml).not.toContain(`${projectHref}/.env`);
  });

  it("depth 1 includes .env", async () => {
    const res = await request(`${base}${projectHref}/`, {
      method: "PROPFIND",
      headers: { depth: "1" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain(`<D:href>${projectHref}/</D:href>`);
    expect(xml).toContain(`<D:href>${projectHref}/.env</D:href>`);
    expect(xml).toContain("text/plain");
  });
});

describe("PROPFIND project .env", () => {
  it("returns file properties", async () => {
    const res = await request(`${base}${projectHref}/.env`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain(`<D:href>${projectHref}/.env</D:href>`);
    expect(xml).toContain("text/plain");
    expect(xml).toContain(
      "Last-Modified".toLowerCase() === "getlastmodified"
        ? "getlastmodified"
        : "D:getlastmodified",
    );
  });
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe("GET project .env", () => {
  it("returns placeholder project content with correct headers", async () => {
    const res = await request(`${base}${projectHref}/.env`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("utf-8");
    expect(res.headers["last-modified"]).toBeDefined();
    expect(res.headers["etag"]).toBeDefined();
    const body = await res.body.text();
    expect(body).toContain(`# d-env project ${project.id}\n`);
    expect(body).toContain(`# staged at: ${project.updatedAt}\n`);
  });

  it("Content-Length matches actual body", async () => {
    const res = await request(`${base}${projectHref}/.env`);
    const body = await res.body.arrayBuffer();
    const claimed = Number(res.headers["content-length"]);
    expect(claimed).toBe(body.byteLength);
  });

  it("no Transfer-Encoding: chunked (macOS requirement)", async () => {
    const res = await request(`${base}${projectHref}/.env`);
    await res.body.dump();
    expect(res.headers["transfer-encoding"]).toBeUndefined();
  });

  it("wrong project token returns 404", async () => {
    const res = await request(`${base}/p/${project.id}.wrong/.env`);
    expect(res.statusCode).toBe(404);
    await res.body.dump();
  });

  it("unknown project id returns 404", async () => {
    const res = await request(`${base}/p/unknown.${project.token}/.env`);
    expect(res.statusCode).toBe(404);
    await res.body.dump();
  });
});

// ---------------------------------------------------------------------------
// HEAD
// ---------------------------------------------------------------------------

describe("HEAD /hello/.env", () => {
  it("returns same headers as GET but no body", async () => {
    const [getRes, headRes] = await Promise.all([
      request(`${base}${projectHref}/.env`, { method: "GET" }),
      request(`${base}${projectHref}/.env`, { method: "HEAD" }),
    ]);
    const getBody = await getRes.body.text();
    await headRes.body.dump();
    expect(headRes.statusCode).toBe(200);
    expect(headRes.headers["content-type"]).toBe(
      getRes.headers["content-type"],
    );
    expect(headRes.headers["content-length"]).toBe(
      getRes.headers["content-length"],
    );
    expect(headRes.headers["etag"]).toBe(getRes.headers["etag"]);
    expect(headRes.headers["last-modified"]).toBe(
      getRes.headers["last-modified"],
    );
    expect(getBody).toContain(`# d-env project ${project.id}\n`);
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown paths
// ---------------------------------------------------------------------------

describe("404 for unknown paths", () => {
  it("GET /nonexistent → 404", async () => {
    const res = await request(`${base}/nonexistent`);
    expect(res.statusCode).toBe(404);
    await res.body.dump();
  });

  it("GET project other.env → 404", async () => {
    const res = await request(`${base}${projectHref}/other.env`);
    expect(res.statusCode).toBe(404);
    await res.body.dump();
  });

  it("PROPFIND /nonexistent → 404", async () => {
    const res = await request(`${base}/nonexistent`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(404);
    await res.body.dump();
  });
});

// ---------------------------------------------------------------------------
// 405 for unimplemented methods
// ---------------------------------------------------------------------------

describe("405 for unimplemented verbs", () => {
  it("PUT → 405", async () => {
    const res = await request(`${base}${projectHref}/.env`, {
      method: "PUT",
      body: "KEY=val\n",
    });
    expect(res.statusCode).toBe(405);
    await res.body.dump();
  });

  it("DELETE → 405", async () => {
    const res = await request(`${base}${projectHref}/.env`, {
      method: "DELETE",
    });
    expect(res.statusCode).toBe(405);
    await res.body.dump();
  });
});
