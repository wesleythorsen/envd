import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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
import type { Cache } from "../../src/core/cache.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { StagingRepo } from "../../src/core/staging.js";
import { providers } from "../../src/providers/registry.js";
import type {
  ChangeSet,
  Provider,
  ProviderContext,
  PushResult,
  SecretMap,
} from "../../src/providers/base.js";

function applyChanges(remote: SecretMap, changes: ChangeSet): SecretMap {
  const next: Record<string, string> = { ...remote };
  for (const key of changes.deletes) {
    delete next[key];
  }
  for (const [key, value] of Object.entries(changes.upserts)) {
    next[key] = value;
  }
  return next;
}

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
// /v1/projects/:id/pull
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/pull", () => {
  const pullToken = generateToken();
  let pullServer: ControlServerHandle;
  let pullBase: string;
  let state: StateStore;
  let tempDir: string;
  let providerFile: string;
  let stagingRepo: StagingRepo;
  let conflictProjectId: string;
  let forceProjectId: string;
  let cacheEvents: string[] = [];
  let fetchedValues: SecretMap[] = [];
  let nextFetchedAt = 123_456;

  const cache: Cache<SecretMap> = {
    async get(projectId, fetcher) {
      cacheEvents.push(`get:${projectId}`);
      const value = await fetcher();
      fetchedValues.push(value);
      return { value, fetchedAt: nextFetchedAt++ };
    },
    invalidate(projectId) {
      cacheEvents.push(`invalidate:${projectId}`);
    },
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-control-pull-"));
    providerFile = join(tempDir, "secrets.json");
    const conflictProjectPath = join(tempDir, "conflict-project");
    const forceProjectPath = join(tempDir, "force-project");
    mkdirSync(conflictProjectPath);
    mkdirSync(forceProjectPath);
    writeFileSync(providerFile, JSON.stringify({ REMOTE: "initial" }), "utf-8");

    state = openState(join(tempDir, "state.db"));
    const projectRepo = new ProjectRepo(state.db);
    const providerInstanceRepo = new ProviderInstanceRepo(state.db);
    stagingRepo = new StagingRepo(state.db);
    const providerInstance = providerInstanceRepo.create({
      provider: "local-file",
      name: "Pull fixture",
      config: JSON.stringify({ path: providerFile }),
    });
    const conflictProject = projectRepo.create({
      path: conflictProjectPath,
      providerInstanceId: providerInstance.id,
    });
    const forceProject = projectRepo.create({
      path: forceProjectPath,
      providerInstanceId: providerInstance.id,
    });
    stagingRepo.setDesired(conflictProject.id, { LOCAL: "pending" });
    stagingRepo.setDesired(forceProject.id, { LOCAL: "discard" });
    conflictProjectId = conflictProject.id;
    forceProjectId = forceProject.id;

    pullServer = await startControlServer({
      port: 0,
      token: pullToken,
      projectRepo,
      providerInstanceRepo,
      stagingRepo,
      cache,
    });
    pullBase = `http://127.0.0.1:${pullServer.port}`;
  });

  beforeEach(() => {
    cacheEvents = [];
    fetchedValues = [];
    nextFetchedAt = 123_456;
  });

  afterAll(async () => {
    await pullServer.close();
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 409 and keeps staging when force is not true", async () => {
    const res = await request(
      `${pullBase}/v1/projects/${conflictProjectId}/pull`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pullToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    expect(res.statusCode).toBe(409);
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("commit_conflict");
    expect(err["message"]).toEqual(expect.stringContaining("force=true"));
    expect((err["details"] as Record<string, unknown>)["stagedKeys"]).toEqual([
      "LOCAL",
    ]);
    expect(stagingRepo.getDesired(conflictProjectId)).toEqual({
      LOCAL: "pending",
    });
    expect(cacheEvents).toEqual([]);
    expect(fetchedValues).toEqual([]);
  });

  it("clears staging, invalidates cache, and fetches a fresh snapshot with force", async () => {
    writeFileSync(
      providerFile,
      JSON.stringify({ REMOTE: "after-force" }),
      "utf-8",
    );

    const res = await request(
      `${pullBase}/v1/projects/${forceProjectId}/pull`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pullToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ force: true }),
      },
    );

    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({ snapshotFetchedAt: 123_456 });
    expect(stagingRepo.getDesired(forceProjectId)).toBeUndefined();
    expect(cacheEvents).toEqual([
      `invalidate:${forceProjectId}`,
      `get:${forceProjectId}`,
    ]);
    expect(fetchedValues).toEqual([{ REMOTE: "after-force" }]);
  });
});

// ---------------------------------------------------------------------------
// /v1/projects/:id/commit
// ---------------------------------------------------------------------------

describe("POST /v1/projects/:id/commit", () => {
  const commitToken = generateToken();
  const commitProviderName = "commit-test";
  const mutableProviders = providers as Provider[];
  let commitServer: ControlServerHandle;
  let commitBase: string;
  let state: StateStore;
  let tempDir: string;
  let stagingRepo: StagingRepo;
  let projectId: string;
  let remoteState: SecretMap = {};
  let pushMode: "ok" | "conflict" | "throw" = "ok";
  let pushedChanges: ChangeSet[] = [];
  let cacheEvents: string[] = [];
  let nextFetchedAt = 200_000;
  const snapshots = new Map<string, { value: SecretMap; fetchedAt: number }>();

  const cache: Cache<SecretMap> & {
    reset(): void;
    seed(projectId: string, value: SecretMap, fetchedAt?: number): void;
  } = {
    reset() {
      snapshots.clear();
      cacheEvents = [];
      nextFetchedAt = 200_000;
    },
    seed(seedProjectId, value, fetchedAt = nextFetchedAt++) {
      snapshots.set(seedProjectId, { value, fetchedAt });
    },
    async get(projectIdForCache, fetcher) {
      cacheEvents.push(`get:${projectIdForCache}`);
      const existing = snapshots.get(projectIdForCache);
      if (existing !== undefined) {
        return existing;
      }
      const value = await fetcher();
      const snapshot = { value, fetchedAt: nextFetchedAt++ };
      snapshots.set(projectIdForCache, snapshot);
      return snapshot;
    },
    invalidate(projectIdForCache) {
      cacheEvents.push(`invalidate:${projectIdForCache}`);
      snapshots.delete(projectIdForCache);
    },
  };

  const commitProvider: Provider = {
    name: commitProviderName,
    instanceConfigSchema: { type: "object" },
    credentialKeys: [],
    create(ctx: ProviderContext, config: unknown) {
      void ctx;
      void config;
      return Promise.resolve({
        fetch() {
          return Promise.resolve({ ...remoteState });
        },
        push(changes: ChangeSet): Promise<PushResult> {
          pushedChanges.push(changes);
          if (pushMode === "throw") {
            return Promise.reject(new Error("simulated provider push failure"));
          }
          if (pushMode === "conflict") {
            return Promise.resolve({
              status: "conflict",
              remote: { ...remoteState },
            });
          }
          remoteState = applyChanges(remoteState, changes);
          return Promise.resolve({ status: "ok", applied: changes });
        },
        test() {
          return Promise.resolve({ ok: true as const });
        },
      });
    },
  };

  beforeAll(async () => {
    mutableProviders.push(commitProvider);

    tempDir = mkdtempSync(join(tmpdir(), "d-env-control-commit-"));
    const projectPath = join(tempDir, "commit-project");
    mkdirSync(projectPath);

    state = openState(join(tempDir, "state.db"));
    const projectRepo = new ProjectRepo(state.db);
    const providerInstanceRepo = new ProviderInstanceRepo(state.db);
    stagingRepo = new StagingRepo(state.db);
    const providerInstance = providerInstanceRepo.create({
      provider: commitProviderName,
      name: "Commit fixture",
      config: JSON.stringify({}),
    });
    const project = projectRepo.create({
      path: projectPath,
      providerInstanceId: providerInstance.id,
    });
    projectId = project.id;

    commitServer = await startControlServer({
      port: 0,
      token: commitToken,
      projectRepo,
      providerInstanceRepo,
      stagingRepo,
      cache,
    });
    commitBase = `http://127.0.0.1:${commitServer.port}`;
  });

  beforeEach(() => {
    stagingRepo.clear(projectId);
    cache.reset();
    remoteState = {};
    pushMode = "ok";
    pushedChanges = [];
  });

  afterAll(async () => {
    await commitServer.close();
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
    const index = mutableProviders.findIndex(
      (provider) => provider.name === commitProviderName,
    );
    if (index !== -1) {
      mutableProviders.splice(index, 1);
    }
  });

  it("applies staged changes on a happy path commit", async () => {
    cache.seed(projectId, { SHARED: "base", KEEP: "same" }, 111);
    remoteState = { SHARED: "base", KEEP: "same" };
    stagingRepo.setDesired(projectId, {
      SHARED: "local",
      KEEP: "same",
      ADDED: "fresh",
    });

    const res = await request(`${commitBase}/v1/projects/${projectId}/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${commitToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "rotate value" }),
    });

    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({
      applied: {
        upserts: { SHARED: "local", ADDED: "fresh" },
        deletes: [],
      },
      commitId: null,
    });
    expect(pushedChanges).toEqual([
      {
        upserts: { SHARED: "local", ADDED: "fresh" },
        deletes: [],
      },
    ]);
    expect(remoteState).toEqual({
      SHARED: "local",
      KEEP: "same",
      ADDED: "fresh",
    });
    expect(stagingRepo.getDesired(projectId)).toBeUndefined();
    expect(cacheEvents).toEqual([
      `get:${projectId}`,
      `invalidate:${projectId}`,
      `get:${projectId}`,
      `invalidate:${projectId}`,
    ]);
  });

  it("returns 409 with structured conflicts for abort strategy", async () => {
    cache.seed(projectId, { SHARED: "base", ONLY_REMOTE: "base" }, 111);
    remoteState = { SHARED: "remote", ONLY_REMOTE: "base" };
    stagingRepo.setDesired(projectId, {
      SHARED: "local",
      ONLY_REMOTE: "base",
    });

    const res = await request(`${commitBase}/v1/projects/${projectId}/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${commitToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ strategy: "abort" }),
    });

    expect(res.statusCode).toBe(409);
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("commit_conflict");
    expect((err["details"] as Record<string, unknown>)["conflicts"]).toEqual([
      {
        key: "SHARED",
        base: "base",
        remote: "remote",
        desired: "local",
      },
    ]);
    expect(pushedChanges).toEqual([]);
    expect(stagingRepo.getDesired(projectId)).toEqual({
      SHARED: "local",
      ONLY_REMOTE: "base",
    });
  });

  it("drops conflicting local edits with strategy=theirs and commits the rest", async () => {
    cache.seed(projectId, { SHARED: "base", KEEP: "same" }, 111);
    remoteState = { SHARED: "remote", KEEP: "same" };
    stagingRepo.setDesired(projectId, {
      SHARED: "local",
      KEEP: "same",
      ADDED: "fresh",
    });

    const res = await request(`${commitBase}/v1/projects/${projectId}/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${commitToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ strategy: "theirs" }),
    });

    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({
      applied: {
        upserts: { ADDED: "fresh" },
        deletes: [],
      },
      commitId: null,
    });
    expect(pushedChanges).toEqual([
      {
        upserts: { ADDED: "fresh" },
        deletes: [],
      },
    ]);
    expect(remoteState).toEqual({
      SHARED: "remote",
      KEEP: "same",
      ADDED: "fresh",
    });
  });

  it("keeps conflicting local edits with strategy=ours", async () => {
    cache.seed(projectId, { SHARED: "base", KEEP: "same" }, 111);
    remoteState = { SHARED: "remote", KEEP: "same" };
    stagingRepo.setDesired(projectId, {
      SHARED: "local",
      KEEP: "same",
      ADDED: "fresh",
    });

    const res = await request(`${commitBase}/v1/projects/${projectId}/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${commitToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ strategy: "ours" }),
    });

    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({
      applied: {
        upserts: { SHARED: "local", ADDED: "fresh" },
        deletes: [],
      },
      commitId: null,
    });
    expect(remoteState).toEqual({
      SHARED: "local",
      KEEP: "same",
      ADDED: "fresh",
    });
  });

  it("surfaces provider push failures", async () => {
    cache.seed(projectId, { VALUE: "base" }, 111);
    remoteState = { VALUE: "base" };
    pushMode = "throw";
    stagingRepo.setDesired(projectId, { VALUE: "local" });

    const res = await request(`${commitBase}/v1/projects/${projectId}/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${commitToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ strategy: "ours" }),
    });

    expect(res.statusCode).toBe(500);
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("provider_unreachable");
    expect(stagingRepo.getDesired(projectId)).toEqual({ VALUE: "local" });
  });

  it("returns 409 when provider.push reports a conflict", async () => {
    cache.seed(projectId, { VALUE: "base" }, 111);
    remoteState = { VALUE: "base" };
    pushMode = "conflict";
    stagingRepo.setDesired(projectId, { VALUE: "local" });

    const res = await request(`${commitBase}/v1/projects/${projectId}/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${commitToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ strategy: "ours" }),
    });

    expect(res.statusCode).toBe(409);
    const body = (await res.body.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("commit_conflict");
    expect((err["details"] as Record<string, unknown>)["remote"]).toEqual({
      VALUE: "base",
    });
    expect(stagingRepo.getDesired(projectId)).toEqual({ VALUE: "local" });
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
