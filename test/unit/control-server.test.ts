import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "undici";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startControlServer,
  generateToken,
  type ControlServerHandle,
} from "../../src/daemon/control/server.js";
import { openState, type StateStore } from "../../src/core/state.js";
import { ProjectRepo } from "../../src/core/project.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { StagingRepo } from "../../src/core/staging.js";

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

// ---------------------------------------------------------------------------
// /v1/projects/:id/diff
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:id/diff", () => {
  const diffToken = generateToken();
  let diffServer: ControlServerHandle;
  let diffBase: string;
  let state: StateStore;
  let tempDir: string;
  let projectId: string;
  let cleanProjectId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-control-diff-"));
    const providerFile = join(tempDir, "secrets.json");
    const projectPath = join(tempDir, "project");
    const cleanProjectPath = join(tempDir, "clean-project");
    mkdirSync(projectPath);
    mkdirSync(cleanProjectPath);
    writeFileSync(
      providerFile,
      JSON.stringify({
        DELETED: "gone",
        KEPT: "same",
        MODIFIED: "old",
      }),
      "utf-8",
    );

    state = openState(join(tempDir, "state.db"));
    const projectRepo = new ProjectRepo(state.db);
    const providerInstanceRepo = new ProviderInstanceRepo(state.db);
    const stagingRepo = new StagingRepo(state.db);
    const providerInstance = providerInstanceRepo.create({
      provider: "local-file",
      name: "Diff fixture",
      config: JSON.stringify({ path: providerFile }),
    });
    const project = projectRepo.create({
      path: projectPath,
      providerInstanceId: providerInstance.id,
    });
    const cleanProject = projectRepo.create({
      path: cleanProjectPath,
      providerInstanceId: providerInstance.id,
    });
    stagingRepo.setDesired(project.id, {
      ADDED: "fresh",
      KEPT: "same",
      MODIFIED: "new",
    });
    projectId = project.id;
    cleanProjectId = cleanProject.id;

    diffServer = await startControlServer({
      port: 0,
      token: diffToken,
      projectRepo,
      providerInstanceRepo,
      stagingRepo,
    });
    diffBase = `http://127.0.0.1:${diffServer.port}`;
  });

  afterAll(async () => {
    await diffServer.close();
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty keys when there is no staging", async () => {
    const res = await request(
      `${diffBase}/v1/projects/${cleanProjectId}/diff`,
      {
        headers: { Authorization: `Bearer ${diffToken}` },
      },
    );

    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({
      keys: { added: [], modified: [], deleted: [] },
    });
  });

  it("returns keys only by default", async () => {
    const res = await request(`${diffBase}/v1/projects/${projectId}/diff`, {
      headers: { Authorization: `Bearer ${diffToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = (await res.body.json()) as Record<string, unknown>;
    expect(body).toEqual({
      keys: {
        added: ["ADDED"],
        modified: ["MODIFIED"],
        deleted: ["DELETED"],
      },
    });
    expect(JSON.stringify(body)).not.toContain("fresh");
    expect(JSON.stringify(body)).not.toContain("old");
  });

  it("includes values when values=true", async () => {
    const res = await request(
      `${diffBase}/v1/projects/${projectId}/diff?values=true`,
      {
        headers: { Authorization: `Bearer ${diffToken}` },
      },
    );

    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({
      keys: {
        added: ["ADDED"],
        modified: ["MODIFIED"],
        deleted: ["DELETED"],
      },
      values: {
        added: { ADDED: "fresh" },
        modified: { MODIFIED: { before: "old", after: "new" } },
        deleted: { DELETED: "gone" },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// /v1/providers and /v1/provider-instances
// ---------------------------------------------------------------------------

describe("/v1/providers and /v1/provider-instances", () => {
  const providerToken = generateToken();
  let providerServer: ControlServerHandle;
  let providerBase: string;
  let state: StateStore;
  let tempDir: string;
  let providerFile: string;
  let projectPath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-control-providers-"));
    providerFile = join(tempDir, "secrets.json");
    projectPath = join(tempDir, "project");
    mkdirSync(projectPath);

    state = openState(join(tempDir, "state.db"));
    providerServer = await startControlServer({
      port: 0,
      token: providerToken,
      projectRepo: new ProjectRepo(state.db),
      providerInstanceRepo: new ProviderInstanceRepo(state.db),
    });
    providerBase = `http://127.0.0.1:${providerServer.port}`;
  });

  afterAll(async () => {
    await providerServer.close();
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists providers and manages a local-file provider instance", async () => {
    const providersRes = await request(`${providerBase}/v1/providers`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });
    expect(providersRes.statusCode).toBe(200);
    const providersBody = (await providersRes.body.json()) as {
      providers?: readonly Record<string, unknown>[];
    };
    expect(providersBody.providers).toHaveLength(2);
    const localFile = providersBody.providers?.find(
      (provider) => provider["name"] === "local-file",
    );
    if (localFile === undefined) {
      throw new Error("expected local-file provider metadata");
    }
    expect(localFile["name"]).toBe("local-file");
    expect(localFile["credentialKeys"]).toEqual([]);

    const createRes = await request(`${providerBase}/v1/provider-instances`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "local-file",
        name: "Local secrets",
        config: { path: providerFile },
        credentials: {},
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const created = (await createRes.body.json()) as Record<string, unknown>;
    const providerInstanceId = created["id"];
    if (typeof providerInstanceId !== "string") {
      throw new Error("expected provider instance id to be a string");
    }

    const listRes = await request(`${providerBase}/v1/provider-instances`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listed = (await listRes.body.json()) as {
      providerInstances?: readonly Record<string, unknown>[];
    };
    expect(listed.providerInstances).toHaveLength(1);
    expect(listed.providerInstances?.[0]).toMatchObject({
      id: providerInstanceId,
      provider: "local-file",
      name: "Local secrets",
      config: { path: providerFile },
    });
    expect(JSON.stringify(listed)).not.toContain("credentials");

    const getRes = await request(
      `${providerBase}/v1/provider-instances/${providerInstanceId}`,
      {
        headers: { Authorization: `Bearer ${providerToken}` },
      },
    );
    expect(getRes.statusCode).toBe(200);
    const got = (await getRes.body.json()) as Record<string, unknown>;
    expect(got).toMatchObject({
      id: providerInstanceId,
      provider: "local-file",
      name: "Local secrets",
      config: { path: providerFile },
    });

    const testRes = await request(
      `${providerBase}/v1/provider-instances/${providerInstanceId}/test`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${providerToken}` },
      },
    );
    expect(testRes.statusCode).toBe(200);
    expect(await testRes.body.json()).toEqual({ ok: true });

    const createProjectRes = await request(`${providerBase}/v1/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: projectPath,
        providerInstanceId,
      }),
    });
    expect(createProjectRes.statusCode).toBe(201);
    const createdProject = (await createProjectRes.body.json()) as Record<
      string,
      unknown
    >;
    const projectId = createdProject["id"];
    if (typeof projectId !== "string") {
      throw new Error("expected project id to be a string");
    }

    const blockedDeleteRes = await request(
      `${providerBase}/v1/provider-instances/${providerInstanceId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${providerToken}` },
      },
    );
    expect(blockedDeleteRes.statusCode).toBe(400);
    const blockedDeleteBody = (await blockedDeleteRes.body.json()) as Record<
      string,
      unknown
    >;
    expect(
      (blockedDeleteBody["error"] as Record<string, unknown>)["code"],
    ).toBe("usage_error");

    const deleteProjectRes = await request(
      `${providerBase}/v1/projects/${projectId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${providerToken}` },
      },
    );
    expect(deleteProjectRes.statusCode).toBe(204);
    await deleteProjectRes.body.dump();

    const deleteRes = await request(
      `${providerBase}/v1/provider-instances/${providerInstanceId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${providerToken}` },
      },
    );
    expect(deleteRes.statusCode).toBe(204);
    await deleteRes.body.dump();

    const missingRes = await request(
      `${providerBase}/v1/provider-instances/${providerInstanceId}`,
      {
        headers: { Authorization: `Bearer ${providerToken}` },
      },
    );
    expect(missingRes.statusCode).toBe(404);
    await missingRes.body.dump();
  });
});
