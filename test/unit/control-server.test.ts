import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "undici";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startControlServer,
  generateToken,
  type ControlServerHandle,
} from "../../src/daemon/control/server.js";
import { openState, type StateStore } from "../../src/core/state.js";
import { ProjectRepo } from "../../src/core/project.js";

const TOKEN = generateToken();

let server: ControlServerHandle;
let base: string;

beforeAll(async () => {
  server = await startControlServer({ port: 0, token: TOKEN });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// /v1/health — happy path
// ---------------------------------------------------------------------------

describe("GET /v1/health", () => {
  it("returns 200 with expected shape when token is valid", async () => {
    const res = await request(`${base}/v1/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(typeof body["version"]).toBe("string");
    expect(typeof body["uptimeSec"]).toBe("number");
    expect(Number.isInteger(body["uptimeSec"])).toBe(true);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(`${base}/v1/health`);
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("unauthorized");
    expect(typeof err["message"]).toBe("string");
  });

  it("returns 401 when token is wrong", async () => {
    const res = await request(`${base}/v1/health`, {
      headers: { Authorization: "Bearer wrongtoken" },
    });
    expect(res.statusCode).toBe(401);
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// /v1/version — happy path
// ---------------------------------------------------------------------------

describe("GET /v1/version", () => {
  it("returns 200 with expected shape when token is valid", async () => {
    const res = await request(`${base}/v1/version`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body["cli"]).toBeNull();
    expect(typeof body["daemon"]).toBe("string");
    expect(body["protocol"]).toBe("v1");
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown paths
// ---------------------------------------------------------------------------

describe("404 for unknown paths", () => {
  it("returns 404 with canonical error shape for an unknown path", async () => {
    const res = await request(`${base}/v1/nope`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("not_found");
    expect(typeof err["message"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 405 for wrong method on a known path
// ---------------------------------------------------------------------------

describe("405 for bad method on known path", () => {
  it("POST /v1/health → 405 with canonical error shape", async () => {
    const res = await request(`${base}/v1/health`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("method_not_allowed");
    expect(typeof err["message"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// /v1/projects
// ---------------------------------------------------------------------------

describe("/v1/projects", () => {
  const projectToken = generateToken();
  let projectServer: ControlServerHandle;
  let projectBase: string;
  let state: StateStore;
  let tempDir: string;
  let projectPath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-control-projects-"));
    projectPath = join(tempDir, "project");
    mkdirSync(projectPath);

    state = openState(join(tempDir, "state.db"));
    projectServer = await startControlServer({
      port: 0,
      token: projectToken,
      projectRepo: new ProjectRepo(state.db),
    });
    projectBase = `http://127.0.0.1:${projectServer.port}`;
  });

  afterAll(async () => {
    await projectServer.close();
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates, lists, gets, and deletes a project", async () => {
    const createRes = await request(`${projectBase}/v1/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${projectToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: projectPath }),
    });

    expect(createRes.statusCode).toBe(201);
    const created = (await createRes.body.json()) as Record<string, unknown>;
    expect(typeof created["id"]).toBe("string");
    expect(typeof created["token"]).toBe("string");
    const projectId = created["id"];
    const projectTokenValue = created["token"];
    if (typeof projectId !== "string") {
      throw new Error("expected project id to be a string");
    }
    if (typeof projectTokenValue !== "string") {
      throw new Error("expected project token to be a string");
    }
    expect(created["mountPath"]).toEqual(
      expect.stringContaining(`/p/${projectId}.${projectTokenValue}/.env`),
    );

    const listRes = await request(`${projectBase}/v1/projects`, {
      headers: { Authorization: `Bearer ${projectToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listed = (await listRes.body.json()) as {
      projects?: readonly Record<string, unknown>[];
    };
    expect(listed.projects?.map((project) => project["id"])).toEqual([
      projectId,
    ]);

    const getRes = await request(`${projectBase}/v1/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${projectToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const got = (await getRes.body.json()) as Record<string, unknown>;
    expect(got["id"]).toBe(projectId);
    expect(got["path"]).toBe(projectPath);

    const deleteRes = await request(`${projectBase}/v1/projects/${projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${projectToken}` },
    });
    expect(deleteRes.statusCode).toBe(204);
    await deleteRes.body.dump();

    const missingRes = await request(
      `${projectBase}/v1/projects/${projectId}`,
      {
        headers: { Authorization: `Bearer ${projectToken}` },
      },
    );
    expect(missingRes.statusCode).toBe(404);
    await missingRes.body.dump();
  });

  it("rejects invalid create bodies", async () => {
    const res = await request(`${projectBase}/v1/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${projectToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: "relative" }),
    });

    expect(res.statusCode).toBe(400);
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("usage_error");
  });
});
