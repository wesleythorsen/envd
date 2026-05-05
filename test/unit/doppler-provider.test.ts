import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import dopplerProvider from "../../src/providers/doppler/index.js";
import { createLogger } from "../../src/shared/logger.js";
import type { ProviderContext } from "../../src/providers/base.js";
import { DEnvError } from "../../src/shared/errors.js";

const apiHost = "https://doppler.test";
const meUrl = `${apiHost}/v3/me`;
const downloadUrl = `${apiHost}/v3/configs/config/secrets/download`;
const updateUrl = `${apiHost}/v3/configs/config/secrets`;
const deleteUrl = `${apiHost}/v3/configs/config/secret`;
const server = setupServer();

function makeContext(apiToken = "dp.test-token"): ProviderContext {
  return {
    keychain: {
      set() {
        return Promise.resolve();
      },
      get(_service, account) {
        return Promise.resolve(account === "apiToken" ? apiToken : null);
      },
      delete() {
        return Promise.resolve();
      },
    },
    logger: createLogger("doppler-test"),
    fetch: globalThis.fetch,
  };
}

async function createInstance() {
  return dopplerProvider.create(makeContext(), {
    project: "web",
    config: "dev",
    apiHost,
  });
}

async function expectDEnvError(promise: Promise<unknown>): Promise<DEnvError> {
  try {
    await promise;
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(DEnvError);
    return err as DEnvError;
  }
  throw new Error("expected promise to reject");
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("doppler provider", () => {
  it("fetches secrets from Doppler's JSON download endpoint", async () => {
    server.use(
      http.get(downloadUrl, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("format")).toBe("json");
        expect(url.searchParams.get("project")).toBe("web");
        expect(url.searchParams.get("config")).toBe("dev");
        expect(request.headers.get("authorization")).toBe(
          "Bearer dp.test-token",
        );
        expect(request.headers.get("accept")).toBe("application/json");
        return HttpResponse.json({ FOO: "bar", EMPTY: "" });
      }),
    );

    const provider = await createInstance();

    expect(await provider.fetch()).toEqual({ FOO: "bar", EMPTY: "" });
  });

  it("tests Doppler auth with v3/me without downloading secrets", async () => {
    let downloads = 0;
    server.use(
      http.get(meUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer dp.test-token",
        );
        expect(request.headers.get("accept")).toBe("application/json");
        return HttpResponse.json({ id: "usr_test" });
      }),
      http.get(downloadUrl, () => {
        downloads += 1;
        return HttpResponse.json({ SHOULD_NOT: "download" });
      }),
    );

    const provider = await createInstance();

    expect(await provider.test()).toEqual({ ok: true });
    expect(downloads).toBe(0);
  });

  it("returns a failed test result when Doppler rejects the token", async () => {
    server.use(http.get(meUrl, () => HttpResponse.json({}, { status: 401 })));

    const provider = await createInstance();

    expect(await provider.test()).toEqual({
      ok: false,
      reason: "doppler provider authentication failed",
    });
  });

  it("returns a failed test result when the API token is missing", async () => {
    const provider = await dopplerProvider.create(makeContext(""), {
      project: "web",
      config: "dev",
      apiHost,
    });

    expect(await provider.test()).toEqual({
      ok: false,
      reason: "doppler provider requires apiToken",
    });
  });

  it("pushes upserts and explicit deletes then verifies with a fresh fetch", async () => {
    const changes = {
      upserts: { FOO: "next", NEW: "value" },
      deletes: ["OLD"],
    };
    const writes: string[] = [];
    let fetches = 0;

    server.use(
      http.post(updateUrl, async ({ request }) => {
        writes.push("upsert");
        expect(request.headers.get("authorization")).toBe(
          "Bearer dp.test-token",
        );
        expect(request.headers.get("accept")).toBe("application/json");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          project: "web",
          config: "dev",
          secrets: { FOO: "next", NEW: "value" },
        });
        return HttpResponse.json({ ignored: "response echo" });
      }),
      http.delete(deleteUrl, ({ request }) => {
        const url = new URL(request.url);
        writes.push(`delete:${url.searchParams.get("name")}`);
        expect(url.searchParams.get("project")).toBe("web");
        expect(url.searchParams.get("config")).toBe("dev");
        expect(request.headers.get("authorization")).toBe(
          "Bearer dp.test-token",
        );
        expect(request.headers.get("accept")).toBe("application/json");
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(downloadUrl, ({ request }) => {
        fetches += 1;
        const url = new URL(request.url);
        expect(url.searchParams.get("format")).toBe("json");
        return HttpResponse.json({ FOO: "next", NEW: "value" });
      }),
    );

    const provider = await createInstance();

    expect(await provider.push(changes)).toEqual({
      status: "ok",
      applied: changes,
    });
    expect(writes).toEqual(["upsert", "delete:OLD"]);
    expect(fetches).toBe(1);
  });

  it("returns conflict with fresh remote secrets when a later write fails", async () => {
    const writes: string[] = [];

    server.use(
      http.post(updateUrl, () => {
        writes.push("upsert");
        return HttpResponse.json({});
      }),
      http.delete(deleteUrl, ({ request }) => {
        const url = new URL(request.url);
        writes.push(`delete:${url.searchParams.get("name")}`);
        return HttpResponse.json({}, { status: 503 });
      }),
      http.get(downloadUrl, () =>
        HttpResponse.json({ NEW: "value", OLD: "still-present" }),
      ),
    );

    const provider = await createInstance();

    await expect(
      provider.push({
        upserts: { NEW: "value" },
        deletes: ["OLD"],
      }),
    ).resolves.toEqual({
      status: "conflict",
      remote: { NEW: "value", OLD: "still-present" },
    });
    expect(writes).toEqual(["upsert", "delete:OLD"]);
  });

  it.each([401, 403])("maps %i responses to provider_auth", async (status) => {
    server.use(http.get(downloadUrl, () => HttpResponse.json({}, { status })));

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_auth");
    expect(err.details).toEqual({ provider: "doppler", statusCode: status });
  });

  it("maps 429 responses to provider_unreachable with retryAfter details", async () => {
    server.use(
      http.get(downloadUrl, () =>
        HttpResponse.json(
          {},
          { status: 429, headers: { "Retry-After": "30" } },
        ),
      ),
    );

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_unreachable");
    expect(err.details).toEqual({
      provider: "doppler",
      statusCode: 429,
      retryAfter: "30",
    });
  });

  it("maps 5xx responses to provider_unreachable", async () => {
    server.use(
      http.get(downloadUrl, () => HttpResponse.json({}, { status: 503 })),
    );

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_unreachable");
    expect(err.details).toEqual({ provider: "doppler", statusCode: 503 });
  });

  it("maps invalid JSON responses to provider_unreachable with cause", async () => {
    server.use(
      http.get(downloadUrl, () =>
        HttpResponse.text("{", {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_unreachable");
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it("validates config shape", async () => {
    await expect(
      dopplerProvider.create(makeContext(), { project: "web" }),
    ).rejects.toBeInstanceOf(DEnvError);
  });
});
