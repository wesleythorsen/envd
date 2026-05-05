/**
 * Integration test: start the US-1.1 WebDAV server, mount it with the darwin
 * adapter, read a file through the mount, then unmount.
 *
 * Gated on darwin — skips cleanly on Linux/CI.
 *
 * Requires /Volumes/ write permission (standard on macOS developer machines).
 */

import { describe, it, expect } from "vitest";
import { readFile, rmdir, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startWebdavServer } from "../../src/daemon/webdav/server.js";
import { DarwinMountAdapter } from "../../src/mount/darwin.js";
import { openState } from "../../src/core/state.js";
import { ProjectRepo } from "../../src/core/project.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";

const isDarwin = process.platform === "darwin";

describe("darwin mount adapter (integration)", () => {
  it.skipIf(!isDarwin)(
    "mounts the WebDAV server, reads a file, and unmounts cleanly",
    async () => {
      // Use a unique tmpdir mount point per test run.
      // Note: /Volumes requires root to mkdir; we use /private/tmp instead,
      // which mount_webdav accepts just fine on macOS.
      const rand = Math.random().toString(36).slice(2, 8);
      const mountPath = `/private/tmp/envd-it-${process.pid}-${rand}`;
      const statePath = `/private/tmp/envd-it-${process.pid}-${rand}.db`;
      const projectPath = `/private/tmp/envd-it-${process.pid}-${rand}-project`;
      const providerPath = `/private/tmp/envd-it-${process.pid}-${rand}-secrets.json`;
      await mkdir(projectPath);
      await writeFile(
        providerPath,
        JSON.stringify({ HELLO: "world" }),
        "utf-8",
      );

      const state = openState(statePath);
      const projectRepo = new ProjectRepo(state.db);
      const providerInstanceRepo = new ProviderInstanceRepo(state.db);
      const providerInstance = providerInstanceRepo.create({
        provider: "local-file",
        name: "Mount test fixture",
        config: JSON.stringify({ path: providerPath }),
      });
      const project = projectRepo.create({
        path: projectPath,
        providerInstanceId: providerInstance.id,
      });
      const server = await startWebdavServer({
        port: 0,
        projectRepo,
        providerInstanceRepo,
      });
      const url = `http://127.0.0.1:${server.port}/`;

      const adapter = new DarwinMountAdapter();

      try {
        await adapter.mount(url, mountPath);

        const filePath = join(
          mountPath,
          "p",
          `${project.id}.${project.token}`,
          ".env",
        );
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
        try {
          await rmdir(projectPath);
        } catch {
          // Ignore cleanup errors.
        }
        state.close();
        await rm(statePath, { force: true });
        await rm(providerPath, { force: true });
        await server.close();
      }
    },
    // mount_webdav can take a few seconds; 30 s is ample.
    30_000,
  );
});
