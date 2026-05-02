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
