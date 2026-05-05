import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import dopplerProvider from "../../src/providers/doppler/index.js";
import { createLogger } from "../../src/shared/logger.js";
import type { ProviderContext } from "../../src/providers/base.js";
import { DEnvError } from "../../src/shared/errors.js";

const apiHost = "https://doppler.test";
const downloadUrl = `${apiHost}/v3/configs/config/secrets/download`;
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
