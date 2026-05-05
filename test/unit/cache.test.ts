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
    expect(cache.peek("project-1")).toEqual({
      value: "first",
      fetchedAt: 1000,
    });
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

  it("coalesces concurrent refreshes after TTL expiry", async () => {
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

    now = 2500;
    const pendingFetch = deferred<string>();
    const fetcher = (): Promise<string> => {
      calls += 1;
      return pendingFetch.promise;
    };

    const first = cache.get("project-1", fetcher, { ttlMs: 1000 });
    const second = cache.get("project-1", fetcher, { ttlMs: 1000 });

    expect(first).toBe(second);
    expect(calls).toBe(2);

    pendingFetch.resolve("second");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: "second", fetchedAt: 2500 },
      { value: "second", fetchedAt: 2500 },
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
    expect(cache.peek("project-1")).toBeUndefined();

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

  it("keeps invalidate races consistent for both in-flight readers", async () => {
    let calls = 0;
    const firstFetch = deferred<string>();
    const secondFetch = deferred<string>();
    const cache = createCache<string>({ now: () => 1000 });
    const fetcher = (): Promise<string> => {
      calls += 1;
      return calls === 1 ? firstFetch.promise : secondFetch.promise;
    };

    const first = cache.get("project-1", fetcher, { ttlMs: 1000 });

    cache.invalidate("project-1");
    const second = cache.get("project-1", fetcher, { ttlMs: 1000 });

    expect(first).toBe(second);
    expect(calls).toBe(1);

    firstFetch.resolve("stale");
    await Promise.resolve();

    expect(calls).toBe(2);

    secondFetch.resolve("fresh");

    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: "fresh", fetchedAt: 1000 },
      { value: "fresh", fetchedAt: 1000 },
    ]);

    const result = await cache.get(
      "project-1",
      () => {
        calls += 1;
        return Promise.resolve("later");
      },
      { ttlMs: 1000 },
    );

    expect(result).toEqual({ value: "fresh", fetchedAt: 1000 });
    expect(calls).toBe(2);
  });

  it("returns undefined from peek when no snapshot has been fetched", () => {
    const cache = createCache<string>();
    expect(cache.peek("missing")).toBeUndefined();
  });
});
