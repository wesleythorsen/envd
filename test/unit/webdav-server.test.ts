import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request } from "undici";
import {
  startWebdavServer,
  type WebdavServerHandle,
} from "../../src/daemon/webdav/server.js";

let server: WebdavServerHandle;
let base: string;

beforeAll(async () => {
  server = await startWebdavServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
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
    // depth 0 — /hello/ must NOT appear
    expect(xml).not.toContain("/hello/");
  });

  it("depth 1 returns root + /hello/ child", async () => {
    const res = await request(`${base}/`, {
      method: "PROPFIND",
      headers: { depth: "1" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:href>/</D:href>");
    expect(xml).toContain("<D:href>/hello/</D:href>");
  });
});

describe("PROPFIND /hello/", () => {
  it("depth 0 returns /hello/ collection", async () => {
    const res = await request(`${base}/hello/`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:href>/hello/</D:href>");
    expect(xml).not.toContain("/hello/.env");
  });

  it("depth 1 includes .env file entry", async () => {
    const res = await request(`${base}/hello/`, {
      method: "PROPFIND",
      headers: { depth: "1" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:href>/hello/</D:href>");
    expect(xml).toContain("<D:href>/hello/.env</D:href>");
    // file entry must not have <D:collection/>
    // verify getcontenttype is present
    expect(xml).toContain("text/plain");
  });
});

describe("PROPFIND /hello/.env", () => {
  it("returns file properties", async () => {
    const res = await request(`${base}/hello/.env`, {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.statusCode).toBe(207);
    const xml = await res.body.text();
    expect(xml).toContain("<D:href>/hello/.env</D:href>");
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

describe("GET /hello/.env", () => {
  it("returns HELLO=world\\n with correct headers", async () => {
    const res = await request(`${base}/hello/.env`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("utf-8");
    expect(res.headers["last-modified"]).toBeDefined();
    expect(res.headers["etag"]).toBeDefined();
    const body = await res.body.text();
    expect(body).toBe("HELLO=world\n");
  });

  it("Content-Length matches actual body", async () => {
    const res = await request(`${base}/hello/.env`);
    const body = await res.body.arrayBuffer();
    const claimed = Number(res.headers["content-length"]);
    expect(claimed).toBe(body.byteLength);
  });

  it("no Transfer-Encoding: chunked (macOS requirement)", async () => {
    const res = await request(`${base}/hello/.env`);
    await res.body.dump();
    expect(res.headers["transfer-encoding"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HEAD
// ---------------------------------------------------------------------------

describe("HEAD /hello/.env", () => {
  it("returns same headers as GET but no body", async () => {
    const [getRes, headRes] = await Promise.all([
      request(`${base}/hello/.env`, { method: "GET" }),
      request(`${base}/hello/.env`, { method: "HEAD" }),
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
    expect(getBody).toBe("HELLO=world\n");
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

  it("GET /hello/other.env → 404", async () => {
    const res = await request(`${base}/hello/other.env`);
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
    const res = await request(`${base}/hello/.env`, {
      method: "PUT",
      body: "KEY=val\n",
    });
    expect(res.statusCode).toBe(405);
    await res.body.dump();
  });

  it("DELETE → 405", async () => {
    const res = await request(`${base}/hello/.env`, { method: "DELETE" });
    expect(res.statusCode).toBe(405);
    await res.body.dump();
  });
});
