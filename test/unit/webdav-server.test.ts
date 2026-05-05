import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { request } from "undici";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  startWebdavServer,
  type WebdavServerHandle,
} from "../../src/daemon/webdav/server.js";
import { openState, type StateStore } from "../../src/core/state.js";
import { ProjectRepo, type Project } from "../../src/core/project.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { createCache } from "../../src/core/cache.js";

let server: WebdavServerHandle;
let base: string;
let state: StateStore;
let tempDir: string;
let project: Project;
let alwaysQuotedProject: Project;
let failingProject: Project;
let projectHref: string;
let alwaysQuotedProjectHref: string;
let failingProjectHref: string;
let providerFile: string;

const FETCHED_AT = Date.UTC(2026, 0, 2, 3, 4, 5);
const EXPECTED_ENV =
  'API_KEY=abc123\nMULTILINE="line\\nbreak"\nSPACED="hello world"\n';
const EXPECTED_ALWAYS_QUOTED_ENV =
  'API_KEY="abc123"\nMULTILINE="line\\nbreak"\nSPACED="hello world"\n';

function sha256Etag(bytes: string): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "d-env-webdav-test-"));
  const projectPath = join(tempDir, "project");
  const alwaysQuotedProjectPath = join(tempDir, "project-always-quoted");
  const failingProjectPath = join(tempDir, "project-failing");
  providerFile = join(tempDir, "secrets.json");
  const failingProviderFile = join(tempDir, "bad-secrets.json");
  mkdirSync(projectPath);
  mkdirSync(alwaysQuotedProjectPath);
  mkdirSync(failingProjectPath);
  writeFileSync(
    providerFile,
    JSON.stringify({
      SPACED: "hello world",
      API_KEY: "abc123",
      MULTILINE: "line\nbreak",
    }),
    "utf-8",
  );
  writeFileSync(failingProviderFile, JSON.stringify({ BAD: 1 }), "utf-8");

  state = openState(join(tempDir, "state.db"));
  const projectRepo = new ProjectRepo(state.db);
  const providerInstanceRepo = new ProviderInstanceRepo(state.db);
  const providerInstance = providerInstanceRepo.create({
    provider: "local-file",
    name: "WebDAV fixture",
    config: JSON.stringify({ path: providerFile }),
  });
  const failingProviderInstance = providerInstanceRepo.create({
    provider: "local-file",
    name: "Broken WebDAV fixture",
    config: JSON.stringify({ path: failingProviderFile }),
  });
  project = projectRepo.create({
    path: projectPath,
    providerInstanceId: providerInstance.id,
  });
  alwaysQuotedProject = projectRepo.create({
    path: alwaysQuotedProjectPath,
    providerInstanceId: providerInstance.id,
    formatConfig: JSON.stringify({
      quote: "always",
      sortKeys: "alphabetical",
    }),
  });
  failingProject = projectRepo.create({
    path: failingProjectPath,
    providerInstanceId: failingProviderInstance.id,
  });
  projectHref = `/p/${project.id}.${project.token}`;
  alwaysQuotedProjectHref = `/p/${alwaysQuotedProject.id}.${alwaysQuotedProject.token}`;
  failingProjectHref = `/p/${failingProject.id}.${failingProject.token}`;
  server = await startWebdavServer({
    port: 0,
    projectRepo,
    providerInstanceRepo,
    cache: createCache({ now: () => FETCHED_AT }),
  });
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
    expect(res.headers["allow"]).toContain("PUT");
    expect(res.headers["allow"]).toContain("LOCK");
    expect(res.headers["allow"]).toContain("UNLOCK");
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
  it("renders provider secrets as dotenv with correct headers", async () => {
    const res = await request(`${base}${projectHref}/.env`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("utf-8");
    expect(res.headers["last-modified"]).toBe(
      new Date(FETCHED_AT).toUTCString(),
    );
    expect(res.headers["etag"]).toBe(sha256Etag(EXPECTED_ENV));
    const body = await res.body.text();
    expect(body).toBe(EXPECTED_ENV);
  });

  it("uses project formatConfig when rendering", async () => {
    const res = await request(`${base}${alwaysQuotedProjectHref}/.env`);
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe(EXPECTED_ALWAYS_QUOTED_ENV);
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

  it("supports If-None-Match revalidation", async () => {
    const first = await request(`${base}${projectHref}/.env`);
    expect(first.statusCode).toBe(200);
    const etag = first.headers["etag"];
    await first.body.dump();
    expect(etag).toBe(sha256Etag(EXPECTED_ENV));

    const second = await request(`${base}${projectHref}/.env`, {
      headers: { "If-None-Match": String(etag) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.headers["etag"]).toBe(etag);
    expect(second.headers["last-modified"]).toBe(
      new Date(FETCHED_AT).toUTCString(),
    );
    await second.body.dump();
  });

  it("serves cached provider snapshots within TTL", async () => {
    const first = await request(`${base}${projectHref}/.env`);
    expect(await first.body.text()).toBe(EXPECTED_ENV);

    writeFileSync(
      providerFile,
      JSON.stringify({ API_KEY: "changed" }),
      "utf-8",
    );

    const second = await request(`${base}${projectHref}/.env`);
    expect(await second.body.text()).toBe(EXPECTED_ENV);
  });

  it("maps provider fetch failures to 503", async () => {
    const res = await request(`${base}${failingProjectHref}/.env`);
    expect(res.statusCode).toBe(503);
    expect(res.headers["x-denv-error"]).toBe("provider_unreachable");
    await res.body.dump();
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
    expect(getBody).toBe(EXPECTED_ENV);
  });
});

// ---------------------------------------------------------------------------
// LOCK / UNLOCK
// ---------------------------------------------------------------------------

describe("LOCK/UNLOCK project .env", () => {
  it("returns a synthetic lock token that UNLOCK drops", async () => {
    const lock = await request(`${base}${projectHref}/.env`, {
      method: "LOCK",
      body: `<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`,
    });
    expect(lock.statusCode).toBe(200);
    expect(lock.headers["timeout"]).toBe("Second-30");
    const lockToken = String(lock.headers["lock-token"]);
    expect(lockToken).toMatch(/^<opaquelocktoken:[0-9a-f-]{36}>$/);
    const xml = await lock.body.text();
    expect(xml).toContain("<D:lockdiscovery>");
    expect(xml).toContain(lockToken.slice(1, -1));

    const unlock = await request(`${base}${projectHref}/.env`, {
      method: "UNLOCK",
      headers: { "Lock-Token": lockToken },
    });
    expect(unlock.statusCode).toBe(204);
    await unlock.body.dump();

    const secondUnlock = await request(`${base}${projectHref}/.env`, {
      method: "UNLOCK",
      headers: { "Lock-Token": lockToken },
    });
    expect(secondUnlock.statusCode).toBe(409);
    await secondUnlock.body.dump();
  });

  it("expires lock tokens after 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const lock = await request(`${base}${projectHref}/.env`, {
        method: "LOCK",
      });
      expect(lock.statusCode).toBe(200);
      const lockToken = String(lock.headers["lock-token"]);
      await lock.body.dump();

      await vi.advanceTimersByTimeAsync(30_001);

      const unlock = await request(`${base}${projectHref}/.env`, {
        method: "UNLOCK",
        headers: { "Lock-Token": lockToken },
      });
      expect(unlock.statusCode).toBe(409);
      await unlock.body.dump();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown paths
// ---------------------------------------------------------------------------

describe("404 for unknown paths", () => {
  it("GET /nonexistent → 404", async () => {
    const res = await request(`${base}/nonexistent`);
    expect(res.statusCode).toBe(404);
    expect(await res.body.text()).toBe("Not Found");
  });

  it("GET project other.env → 404", async () => {
    const res = await request(`${base}${projectHref}/other.env`);
    expect(res.statusCode).toBe(404);
    expect(await res.body.text()).toBe("Not Found");
  });

  it("PROPFIND /nonexistent → 404", async () => {
    const res = await request(`${base}/nonexistent`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(404);
    expect(await res.body.text()).toBe("Not Found");
  });

  it("uses the same 404 response for malformed or unauthorized project paths", async () => {
    const cases: Array<{
      method: "GET" | "PUT" | "PROPFIND" | "LOCK" | "UNLOCK";
      path: string;
      headers?: Record<string, string>;
      body?: string;
    }> = [
      { method: "GET", path: `${projectHref}/other.env` },
      { method: "GET", path: `/p/${project.id}.wrong/.env` },
      { method: "GET", path: `/p/unknown.${project.token}/.env` },
      { method: "PUT", path: `/p/${project.id}.wrong/.env`, body: "IGNORED=1\n" },
      {
        method: "PROPFIND",
        path: `/p/${project.id}.wrong/.env`,
        headers: { depth: "0" },
      },
      { method: "LOCK", path: `/p/${project.id}.wrong/.env`, body: "" },
      {
        method: "UNLOCK",
        path: `/p/${project.id}.wrong/.env`,
        headers: { "Lock-Token": "<opaquelocktoken:test>" },
      },
      { method: "GET", path: "/p/%2E%2E/.env" },
      { method: "GET", path: "/p/not-a-project" },
    ];

    for (const testCase of cases) {
      const res = await request(`${base}${testCase.path}`, {
        method: testCase.method,
        headers: testCase.headers,
        body: testCase.body,
      });
      expect(res.statusCode).toBe(404);
      expect(await res.body.text()).toBe("Not Found");
      expect(res.headers["x-denv-error"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 405 for unimplemented methods
// ---------------------------------------------------------------------------

describe("405 for unimplemented verbs", () => {
  it("MKCOL → 405", async () => {
    const res = await request(`${base}${projectHref}/.env`, {
      method: "MKCOL",
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
