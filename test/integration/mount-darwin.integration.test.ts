/**
 * Integration test: start the US-1.1 WebDAV server, mount it with the darwin
 * adapter, read a file through the mount, then unmount.
 *
 * Gated on darwin — skips cleanly on Linux/CI.
 *
 * Requires /Volumes/ write permission (standard on macOS developer machines).
 */

import { describe, it, expect } from "vitest";
import { readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { startWebdavServer } from "../../src/daemon/webdav/server.js";
import { DarwinMountAdapter } from "../../src/mount/darwin.js";

const isDarwin = process.platform === "darwin";

describe("darwin mount adapter (integration)", () => {
  it.skipIf(!isDarwin)(
    "mounts the WebDAV server, reads a file, and unmounts cleanly",
    async () => {
      // Use a unique tmpdir mount point per test run.
      // Note: /Volumes requires root to mkdir; we use /private/tmp instead,
      // which mount_webdav accepts just fine on macOS.
      const rand = Math.random().toString(36).slice(2, 8);
      const mountPath = `/private/tmp/d-env-it-${process.pid}-${rand}`;

      const server = await startWebdavServer({ port: 0 });
      const url = `http://127.0.0.1:${server.port}/`;

      const adapter = new DarwinMountAdapter();

      try {
        await adapter.mount(url, mountPath);

        // The server serves HELLO=world at /hello/.env
        const filePath = join(mountPath, "hello", ".env");
        const content = await readFile(filePath, "utf-8");
        expect(content).toBe("HELLO=world\n");
      } finally {
        // Best-effort unmount and cleanup — always runs even if the read fails.
        try {
          await adapter.unmount(mountPath);
        } catch {
          // If unmount fails, we still try to clean up the directory.
        }
        try {
          await rmdir(mountPath);
        } catch {
          // Directory may not exist if mount never succeeded; ignore.
        }
        await server.close();
      }
    },
    // mount_webdav can take a few seconds; 30 s is ample.
    30_000,
  );
});
