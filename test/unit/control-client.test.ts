import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startControlServer,
  generateToken,
  type ControlServerHandle,
} from "../../src/daemon/control/server.js";
import {
  createControlClient,
  type ControlClient,
} from "../../src/ipc/control-client.js";
import { DEnvError } from "../../src/shared/errors.js";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openState, type StateStore } from "../../src/core/state.js";
import { ProjectRepo } from "../../src/core/project.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { StagingRepo } from "../../src/core/staging.js";

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

const TOKEN = generateToken();
const WRONG_TOKEN = generateToken();

let server: ControlServerHandle;
let client: ControlClient;

beforeAll(async () => {
  server = await startControlServer({ port: 0, token: TOKEN });
  client = createControlClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: TOKEN,
  });
});

afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// health() — happy path
// ---------------------------------------------------------------------------

describe("health() happy path", () => {
  it("returns the expected shape", async () => {
    const result = await client.health();
    expect(result.ok).toBe(true);
    expect(typeof result.version).toBe("string");
    expect(typeof result.uptimeSec).toBe("number");
    expect(Number.isInteger(result.uptimeSec)).toBe(true);
    expect(result.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// version() — happy path
// ---------------------------------------------------------------------------

describe("version() happy path", () => {
  it("returns the expected shape", async () => {
    const result = await client.version();
    // Server sets cli to null; daemon is the package version string.
    expect(result.cli).toBeNull();
    expect(typeof result.daemon).toBe("string");
    expect(result.protocol).toBe("v1");
  });
});

// ---------------------------------------------------------------------------
// project APIs — happy path
// ---------------------------------------------------------------------------

describe("project APIs happy path", () => {
  const projectToken = generateToken();
  let projectServer: ControlServerHandle;
  let projectClient: ControlClient;
  let state: StateStore;
  let tempDir: string;
  let projectPath: string;
  let providerFile: string;
  let providerInstances: ProviderInstanceRepo;
  let stagingRepo: StagingRepo;
  let providerInstanceId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-client-projects-"));
    projectPath = join(tempDir, "project");
    providerFile = join(tempDir, "provider.json");
    mkdirSync(projectPath);
    writeFileSync(providerFile, JSON.stringify({ BASE: "remote" }));
    state = openState(join(tempDir, "state.db"));
    providerInstances = new ProviderInstanceRepo(state.db);
    stagingRepo = new StagingRepo(state.db);
    providerInstanceId = providerInstances.create({
      provider: "local-file",
      name: "Project status fixture",
      config: JSON.stringify({ path: providerFile }),
    }).id;
    projectServer = await startControlServer({
      port: 0,
      token: projectToken,
      projectRepo: new ProjectRepo(state.db),
      providerInstanceRepo: providerInstances,
      stagingRepo,
    });
    projectClient = createControlClient({
      baseUrl: `http://127.0.0.1:${projectServer.port}`,
      token: projectToken,
    });
  });

  afterAll(async () => {
    await projectServer.close();
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates, gets, and reports project status", async () => {
    const created = await projectClient.createProject({
      path: projectPath,
      providerInstanceId,
    });
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.mountPath).toContain(
      `/p/${created.id}.${created.token}/.env`,
    );

    const detail = await projectClient.getProject(created.id);
    expect(detail.id).toBe(created.id);
    expect(detail.path).toBe(projectPath);
    expect(detail.mountPath).toBe(created.mountPath);

    stagingRepo.setDesired(created.id, {
      ADDED: "fresh",
      BASE: "changed",
      REMOVED: null,
    });
    writeFileSync(
      providerFile,
      JSON.stringify({ BASE: "remote", REMOVED: "present" }),
    );

    const status = await projectClient.getProjectStatus(created.id);
    expect(status).toEqual({
      providerInstanceId,
      provider: "local-file",
      providerInstanceName: "Project status fixture",
      providerHealthy: true,
      providerError: null,
      lastFetchTime: expect.any(Number),
      staged: {
        added: 1,
        modified: 1,
        deleted: 1,
        total: 3,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// provider APIs — happy path
// ---------------------------------------------------------------------------

describe("provider APIs happy path", () => {
  const providerToken = generateToken();
  let providerServer: ControlServerHandle;
  let providerClient: ControlClient;
  let state: StateStore;
  let tempDir: string;
  let providerFile: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-client-providers-"));
    providerFile = join(tempDir, "secrets.json");
    state = openState(join(tempDir, "state.db"));
    providerServer = await startControlServer({
      port: 0,
      token: providerToken,
      projectRepo: new ProjectRepo(state.db),
      providerInstanceRepo: new ProviderInstanceRepo(state.db),
    });
    providerClient = createControlClient({
      baseUrl: `http://127.0.0.1:${providerServer.port}`,
      token: providerToken,
    });
  });

  afterAll(async () => {
    await providerServer.close();
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists providers and creates, tests, gets, lists, and deletes a local-file instance", async () => {
    const providers = await providerClient.listProviders();
    expect(providers.map((provider) => provider.name)).toEqual([
      "local-file",
      "doppler",
    ]);
    expect(providers[0]?.credentialKeys).toEqual([]);
    expect(providers[1]?.credentialKeys).toEqual(["apiToken"]);

    const created = await providerClient.createProviderInstance({
      provider: "local-file",
      name: "Local secrets",
      config: { path: providerFile },
      credentials: {},
    });
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const testResult = await providerClient.testProviderInstance(created.id);
    expect(testResult).toEqual({ ok: true });

    const detail = await providerClient.getProviderInstance(created.id);
    expect(detail).toMatchObject({
      id: created.id,
      provider: "local-file",
      name: "Local secrets",
      config: { path: providerFile },
    });

    const instances = await providerClient.listProviderInstances();
    expect(instances.map((instance) => instance.id)).toEqual([created.id]);
    expect(JSON.stringify(instances)).not.toContain("credentials");

    await providerClient.deleteProviderInstance(created.id);
    await expect(
      providerClient.getProviderInstance(created.id),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DEnvError && err.code === "not_found";
    });
  });
});

// ---------------------------------------------------------------------------
// Wrong token → DEnvError { code: "unauthorized" }
// ---------------------------------------------------------------------------

describe("wrong token", () => {
  it("throws DEnvError with code=unauthorized", async () => {
    const badClient = createControlClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: WRONG_TOKEN,
    });

    await expect(badClient.health()).rejects.toSatisfy((err: unknown) => {
      return err instanceof DEnvError && err.code === "unauthorized";
    });
  });
});

// ---------------------------------------------------------------------------
// Server not running → DEnvError { code: "daemon_unreachable" }
// ---------------------------------------------------------------------------

describe("server not running", () => {
  it("throws DEnvError with code=daemon_unreachable on connection refused", async () => {
    // Port 19109 is in the high dynamic range; nothing should be listening there.
    // We pick a fixed high port rather than allocating a real one because we
    // want a genuine ECONNREFUSED from the OS, not a "bad port" validation error.
    const downClient = createControlClient({
      baseUrl: "http://127.0.0.1:19109",
      token: TOKEN,
    });

    await expect(downClient.health()).rejects.toSatisfy((err: unknown) => {
      return err instanceof DEnvError && err.code === "daemon_unreachable";
    });
  });
});

// ---------------------------------------------------------------------------
// Timeout → DEnvError { code: "daemon_unreachable", message: "timeout" }
// ---------------------------------------------------------------------------

describe("timeout", () => {
  // Spin up a server that accepts the connection but never responds.
  let slowServer: Server;
  let slowPort: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      slowServer = createServer(() => {
        // Intentionally never writes a response — keeps the socket open.
      });
      slowServer.listen(0, "127.0.0.1", () => {
        const addr = slowServer.address();
        if (addr !== null && typeof addr === "object") {
          slowPort = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      slowServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("throws DEnvError with code=daemon_unreachable and message=timeout", async () => {
    const timeoutClient = createControlClient({
      baseUrl: `http://127.0.0.1:${slowPort}`,
      token: TOKEN,
      timeoutMs: 50, // very short for a fast test
    });

    await expect(timeoutClient.health()).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DEnvError &&
        err.code === "daemon_unreachable" &&
        err.message === "timeout"
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Missing ports file (no baseUrl, no token file) → daemon_unreachable
// ---------------------------------------------------------------------------

describe("missing ports file / token file", () => {
  it("throws daemon_unreachable when neither baseUrl nor ports file exist", () => {
    // D_ENV_HOME points to a directory that has no ports.json
    const origHome = process.env["D_ENV_HOME"];
    process.env["D_ENV_HOME"] = "/tmp/d-env-nonexistent-" + Date.now();
    try {
      expect(() => createControlClient()).toThrow(DEnvError);
      expect(() => createControlClient()).toSatisfy((fn: () => void) => {
        try {
          fn();
          return false;
        } catch (err) {
          return err instanceof DEnvError && err.code === "daemon_unreachable";
        }
      });
    } finally {
      if (origHome === undefined) {
        delete process.env["D_ENV_HOME"];
      } else {
        process.env["D_ENV_HOME"] = origHome;
      }
    }
  });

  it("throws daemon_unreachable when baseUrl is given but token file is missing", () => {
    const origHome = process.env["D_ENV_HOME"];
    process.env["D_ENV_HOME"] = "/tmp/d-env-nonexistent-" + Date.now();
    try {
      expect(() =>
        createControlClient({ baseUrl: "http://127.0.0.1:1910" }),
      ).toThrow(DEnvError);
    } finally {
      if (origHome === undefined) {
        delete process.env["D_ENV_HOME"];
      } else {
        process.env["D_ENV_HOME"] = origHome;
      }
    }
  });

  it.todo(
    "timeout with a server that delays beyond timeoutMs — covered by the 'timeout' describe block above",
  );
});
