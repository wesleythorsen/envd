// smoke-macos.ts — end-to-end smoke test for the WebDAV-mount-read flow.
//
// macOS only: relies on /sbin/mount_webdav and /sbin/umount.
// Requires write access to /private/tmp.
// NOT part of `npm test` — it performs a real OS-level mount (side-effecting).
// Run with: npm run smoke:macos

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { startWebdavServer } from "../src/daemon/webdav/server.js";
import { createMountAdapter } from "../src/mount/index.js";

const MOUNT_TIMEOUT_MS = 10_000;
const EXPECTED_CONTENT = "HELLO=world\n";

function randomSuffix(): string {
  return crypto.randomBytes(3).toString("hex"); // 6 chars
}

function fail(step: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[smoke-macos] FAILED at step "${step}": ${message}\n`);
  process.exit(1);
}

/** Wraps a promise with a timeout; rejects with a clear message if exceeded. */
function withTimeout<T>(
  step: string,
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        // Re-reject; wrap non-Error values so the rule is satisfied.
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function main(): Promise<void> {
  const mountPath = path.join(
    "/private/tmp",
    `d-env-smoke-${process.pid}-${randomSuffix()}`,
  );

  // --- Step 1: Start the WebDAV server ---
  let server: Awaited<ReturnType<typeof startWebdavServer>>;
  try {
    server = await startWebdavServer({ port: 0 }); // ephemeral port
  } catch (err) {
    fail("start WebDAV server", err);
  }

  const adapter = await createMountAdapter().catch((err: unknown) => {
    // server isn't mounted yet so we can close inline without finally
    void server.close();
    fail("create mount adapter", err);
  });

  let mounted = false;

  try {
    // --- Step 2: Mount at an ephemeral path in /private/tmp ---
    const url = `http://127.0.0.1:${server.port}/`;
    try {
      await withTimeout(
        "mount WebDAV",
        adapter.mount(url, mountPath),
        MOUNT_TIMEOUT_MS,
      );
      mounted = true;
    } catch (err) {
      fail("mount WebDAV", err);
    }

    // --- Step 3: Read hello/.env and assert content ---
    const envFile = path.join(mountPath, "hello", ".env");
    let content: string;
    try {
      content = await fs.readFile(envFile, "utf-8");
    } catch (err) {
      fail("read hello/.env", err);
    }

    if (content !== EXPECTED_CONTENT) {
      fail(
        "assert content",
        new Error(
          `expected ${JSON.stringify(EXPECTED_CONTENT)}, got ${JSON.stringify(content)}`,
        ),
      );
    }
  } finally {
    // --- Step 4: Unmount ---
    if (mounted) {
      try {
        await adapter.unmount(mountPath);
      } catch (err) {
        process.stderr.write(
          `[smoke-macos] WARNING: unmount failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // --- Step 5: Close the WebDAV server ---
    try {
      await server.close();
    } catch (err) {
      process.stderr.write(
        `[smoke-macos] WARNING: server close failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // --- Step 6: Report success ---
  process.stdout.write("[smoke-macos] SUCCESS\n");
  process.exit(0);
}

await main();
