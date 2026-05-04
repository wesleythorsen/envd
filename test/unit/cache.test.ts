import { describe, expect, it } from "vitest";
import { createCache } from "../../src/core/cache.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("createCache", () => {
  it("fetches fresh values and records fetchedAt", async () => {
    const now = 1000;
    let calls = 0;
    const cache = createCache<string>({ now: () => now });

    const result = await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("fresh");
      },
      { ttlMs: 1000 },
    );

    expect(result).toEqual({ value: "fresh", fetchedAt: 1000 });
    expect(calls).toBe(1);
  });

  it("returns the cached value within TTL", async () => {
    let now = 1000;
    let calls = 0;
    const cache = createCache<string>({ now: () => now });

    await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("first");
      },
      { ttlMs: 1000 },
    );

    now = 1500;
    const result = await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("second");
      },
      { ttlMs: 1000 },
    );

    expect(result).toEqual({ value: "first", fetchedAt: 1000 });
    expect(calls).toBe(1);
  });

  it("refetches values after TTL expires", async () => {
    let now = 1000;
    let calls = 0;
    const cache = createCache<string>({ now: () => now });

    await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("first");
      },
      { ttlMs: 1000 },
    );

    now = 2000;
    const result = await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("second");
      },
      { ttlMs: 1000 },
    );

    expect(result).toEqual({ value: "second", fetchedAt: 2000 });
    expect(calls).toBe(2);
  });

  it("coalesces concurrent fetches per project", async () => {
    let calls = 0;
    const pendingFetch = deferred<string>();
    const cache = createCache<string>({ now: () => 1000 });
    const fetcher = (): Promise<string> => {
      calls += 1;
      return pendingFetch.promise;
    };

    const first = cache.get("project-1", fetcher, { ttlMs: 1000 });
    const second = cache.get("project-1", fetcher, { ttlMs: 1000 });

    expect(first).toBe(second);
    expect(calls).toBe(1);

    pendingFetch.resolve("coalesced");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: "coalesced", fetchedAt: 1000 },
      { value: "coalesced", fetchedAt: 1000 },
    ]);
  });

  it("invalidates cached values", async () => {
    let calls = 0;
    const cache = createCache<string>({ now: () => 1000 });

    await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("first");
      },
      { ttlMs: 1000 },
    );

    cache.invalidate("project-1");

    const result = await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("second");
      },
      { ttlMs: 1000 },
    );

    expect(result).toEqual({ value: "second", fetchedAt: 1000 });
    expect(calls).toBe(2);
  });

  it("does not repopulate the cache from an invalidated in-flight fetch", async () => {
    let calls = 0;
    const pendingFetch = deferred<string>();
    const cache = createCache<string>({ now: () => 1000 });

    const first = cache.get(
      "project-1",
      () => {
        calls += 1;
        return pendingFetch.promise;
      },
      { ttlMs: 1000 },
    );

    cache.invalidate("project-1");
    pendingFetch.resolve("stale");

    await expect(first).resolves.toEqual({ value: "stale", fetchedAt: 1000 });

    const result = await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("fresh");
      },
      { ttlMs: 1000 },
    );

    expect(result).toEqual({ value: "fresh", fetchedAt: 1000 });
    expect(calls).toBe(2);
  });
});
