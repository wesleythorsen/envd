import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "undici";
import {
  startControlServer,
  generateToken,
  type ControlServerHandle,
} from "../../src/daemon/control/server.js";

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
