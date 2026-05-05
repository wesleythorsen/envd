export interface CacheOptions {
  readonly now?: () => number;
}

export interface CacheGetOptions {
  readonly ttlMs: number;
}

export interface CacheResult<T> {
  readonly value: T;
  readonly fetchedAt: number;
}

export interface Cache<T> {
  get(
    projectId: string,
    fetcher: () => Promise<T>,
    opts: CacheGetOptions,
  ): Promise<CacheResult<T>>;
  peek(projectId: string): CacheResult<T> | undefined;
  invalidate(projectId: string): void;
}

interface InternalEntry<T> {
  snapshot?: CacheResult<T>;
  pending?: Promise<CacheResult<T>>;
  invalidated?: boolean;
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new RangeError("ttlMs must be a non-negative finite number");
  }
}

function isFresh<T>(
  snapshot: CacheResult<T>,
  now: number,
  ttlMs: number,
): boolean {
  return now - snapshot.fetchedAt < ttlMs;
}

function callFetcher<T>(fetcher: () => Promise<T>): Promise<T> {
  try {
    return fetcher();
  } catch (error: unknown) {
    return Promise.reject(toError(error));
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error("cache fetcher failed", { cause: error });
}

export function createCache<T = unknown>(opts: CacheOptions = {}): Cache<T> {
  const entries = new Map<string, InternalEntry<T>>();
  const now = opts.now ?? Date.now;

  function clearPending(projectId: string, entry: InternalEntry<T>): void {
    if (entries.get(projectId) !== entry) {
      return;
    }

    delete entry.pending;
    if (entry.snapshot === undefined) {
      delete entry.invalidated;
      entries.delete(projectId);
    }
  }

  function startFetch(
    projectId: string,
    entry: InternalEntry<T>,
    fetcher: () => Promise<T>,
  ): Promise<CacheResult<T>> {
    const pending = callFetcher(fetcher)
      .then((value) => {
        const snapshot: CacheResult<T> = {
          value,
          fetchedAt: now(),
        };

        if (entry.invalidated === true) {
          delete entry.pending;
          delete entry.snapshot;
          delete entry.invalidated;
          return startFetch(projectId, entry, fetcher);
        }

        if (entries.get(projectId) === entry) {
          entry.snapshot = snapshot;
          delete entry.pending;
        }

        return snapshot;
      })
      .catch((error: unknown) => {
        clearPending(projectId, entry);
        throw error;
      });

    entry.pending = pending;
    entries.set(projectId, entry);
    return pending;
  }

  return {
    get(projectId, fetcher, getOpts) {
      validateTtl(getOpts.ttlMs);

      const existing = entries.get(projectId);
      if (existing?.pending !== undefined) {
        return existing.pending;
      }

      const currentTime = now();
      if (
        existing?.snapshot !== undefined &&
        isFresh(existing.snapshot, currentTime, getOpts.ttlMs)
      ) {
        return Promise.resolve(existing.snapshot);
      }

      const entry = existing ?? {};
      return startFetch(projectId, entry, fetcher);
    },

    peek(projectId) {
      return entries.get(projectId)?.snapshot;
    },

    invalidate(projectId) {
      const entry = entries.get(projectId);
      if (entry === undefined) {
        return;
      }
      if (entry.pending !== undefined) {
        delete entry.snapshot;
        entry.invalidated = true;
        return;
      }
      entries.delete(projectId);
    },
  };
}
