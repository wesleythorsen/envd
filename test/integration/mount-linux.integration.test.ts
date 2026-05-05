/**
 * Manual Linux smoke test for the davfs2 mount adapter.
 *
 * Example Debian container command:
 * docker run --rm -it --cap-add SYS_ADMIN --device /dev/fuse \
 *   --security-opt apparmor:unconfined \
 *   -v "$PWD":/work -w /work node:22-bookworm bash -lc \
 *   "apt-get update && apt-get install -y davfs2 fuse3 && npm ci && npm run build && ENVD_RUN_LINUX_MOUNT_IT=1 npm test -- test/integration/mount-linux.integration.test.ts"
 *
 * The test is gated so it does not run in normal local npm test flows.
 */

import { describe, expect, it } from "vitest";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebdavServer } from "../../src/daemon/webdav/server.js";
import { LinuxMountAdapter } from "../../src/mount/linux.js";
import { openState } from "../../src/core/state.js";
import { ProjectRepo } from "../../src/core/project.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";

const shouldRun =
  process.platform === "linux" &&
  process.env["ENVD_RUN_LINUX_MOUNT_IT"] === "1";

describe("linux mount adapter (integration)", () => {
  it.skipIf(!shouldRun)(
    "mounts the WebDAV server, reads a file, and unmounts cleanly",
    async () => {
      const rand = Math.random().toString(36).slice(2, 8);
      const mountPath = join(tmpdir(), `envd-linux-it-${process.pid}-${rand}`);
      const statePath = join(
        tmpdir(),
        `envd-linux-it-${process.pid}-${rand}.db`,
      );
      const projectPath = join(
        tmpdir(),
        `envd-linux-it-${process.pid}-${rand}-project`,
      );
      const providerPath = join(
        tmpdir(),
        `envd-linux-it-${process.pid}-${rand}-secrets.json`,
      );

      await mkdir(mountPath);
      await mkdir(projectPath, { recursive: true });
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
        name: "Linux mount fixture",
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
      const adapter = new LinuxMountAdapter();

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
        try {
          await adapter.unmount(mountPath);
        } catch {
          // best effort
        }
        state.close();
        await rm(mountPath, { recursive: true, force: true });
        await rm(projectPath, { recursive: true, force: true });
        await rm(providerPath, { force: true });
        await rm(statePath, { force: true });
        await server.close();
      }
    },
    30_000,
  );
});
