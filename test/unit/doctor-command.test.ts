import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  doctorProject,
  formatDoctorHuman,
  type DoctorResult,
} from "../../src/cli/commands/doctor.js";
import type { StatusResult } from "../../src/cli/commands/status.js";

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-doctor-command-"));
  mkdirSync(join(dir, "project"));
  const projectDir = realpathSync.native(join(dir, "project"));
  const previousHome = process.env["ENVD_HOME"];
  process.env["ENVD_HOME"] = dir;
  return fn(projectDir).finally(() => {
    if (previousHome === undefined) {
      delete process.env["ENVD_HOME"];
    } else {
      process.env["ENVD_HOME"] = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

function healthyStatus(projectDir: string): StatusResult {
  const mountPath = "/tmp/envd-mount/p/project-1.token/.env";
  return {
    daemon: {
      running: true,
      pid: 123,
      ports: { control: 1910, webdav: 1911 },
      version: "test",
      uptimeSec: 10,
      error: null,
    },
    mount: { path: "/tmp/envd-mount", mounted: true, error: null },
    project: {
      path: projectDir,
      projectId: "project-1",
      activeEnvironment: "default",
      envPath: join(projectDir, ".env"),
      symlinkTarget: mountPath,
      linkState: "linked",
      registered: true,
      mountPath,
      format: "dotenv",
      provider: {
        instanceId: "provider-1",
        provider: "local-file",
        name: "personal",
        healthy: true,
        error: null,
      },
      staging: { added: 0, modified: 0, deleted: 0, total: 0 },
      lastFetchTime: "2026-01-01T00:00:00.000Z",
      nextAction: "no action needed",
    },
  };
}

function stoppedStatus(): StatusResult {
  return {
    daemon: {
      running: false,
      pid: null,
      ports: null,
      version: null,
      uptimeSec: null,
      error: "daemon unreachable",
    },
    mount: { path: "/tmp/envd-mount", mounted: false, error: "not mounted" },
    project: null,
  };
}

function check(result: DoctorResult, id: string) {
  const found = result.checks.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`missing doctor check ${id}`);
  }
  return found;
}

describe("doctor command helpers", () => {
  it("reports a healthy local setup without secret values", async () => {
    await withTempProject(async (projectDir) => {
      writeFileSync(
        join(process.env["ENVD_HOME"] ?? "", "control-token"),
        "secret-value",
      );

      const result = await doctorProject(
        { path: projectDir },
        {
          getStatus: () => Promise.resolve(healthyStatus(projectDir)),
        },
      );

      expect(result.status).toBe("ok");
      expect(result.checks.every((item) => item.status === "ok")).toBe(true);
      expect(formatDoctorHuman(result)).not.toContain("secret-value");
    });
  });

  it("repairs a broken managed .env symlink with --fix", async () => {
    await withTempProject(async (projectDir) => {
      const oldTarget = "/tmp/envd-mount/p/project-1.old/.env";
      const newTarget = "/tmp/envd-mount/p/project-1.new/.env";
      symlinkSync(oldTarget, join(projectDir, ".env"));
      const status = {
        ...healthyStatus(projectDir),
        project: {
          ...healthyStatus(projectDir).project,
          symlinkTarget: oldTarget,
          linkState: "stale" as const,
          mountPath: newTarget,
        },
      };

      const result = await doctorProject(
        { path: projectDir, fix: true },
        {
          getStatus: () => Promise.resolve(status),
        },
      );

      expect(check(result, "env_link").fixed).toBe(true);
      expect(readlinkSync(join(projectDir, ".env"))).toBe(newTarget);
    });
  });

  it("reports a stopped daemon without autostarting it", async () => {
    await withTempProject(async (projectDir) => {
      const result = await doctorProject(
        { path: projectDir },
        { getStatus: () => Promise.resolve(stoppedStatus()) },
      );

      expect(result.status).toBe("issues_found");
      expect(check(result, "daemon")).toMatchObject({
        status: "error",
        summary: "daemon is not healthy",
      });
    });
  });

  it("removes stale pid and ports files with --fix", async () => {
    await withTempProject(async (projectDir) => {
      const home = process.env["ENVD_HOME"] ?? "";
      const pidPath = join(home, "envdd.pid");
      const portsPath = join(home, "ports.json");
      writeFileSync(pidPath, "999999", "utf-8");
      writeFileSync(
        portsPath,
        JSON.stringify({ control: 1910, webdav: 1911 }),
        "utf-8",
      );

      const result = await doctorProject(
        { path: projectDir, fix: true },
        {
          getStatus: () => Promise.resolve(stoppedStatus()),
          isPidAlive: () => false,
        },
      );

      expect(check(result, "runtime.pid").fixed).toBe(true);
      expect(check(result, "runtime.ports").fixed).toBe(true);
      expect(existsSync(pidPath)).toBe(false);
      expect(existsSync(portsPath)).toBe(false);
    });
  });

  it("repairs an unavailable mount with --fix when the daemon is running", async () => {
    await withTempProject(async (projectDir) => {
      const base = healthyStatus(projectDir);
      const mountCalls: Array<{ url: string; path: string }> = [];
      const result = await doctorProject(
        { path: projectDir, fix: true },
        {
          getStatus: () =>
            Promise.resolve({
              ...base,
              mount: {
                path: "/tmp/envd-mount",
                mounted: false,
                error: null,
              },
            }),
          mountAdapter: {
            platform: "darwin",
            isMounted: () => Promise.resolve(false),
            mount: (url, path) => {
              mountCalls.push({ url, path });
              return Promise.resolve();
            },
            unmount: () => Promise.resolve(),
          },
        },
      );

      expect(check(result, "mount")).toMatchObject({
        status: "warning",
        fixable: true,
        fixed: true,
      });
      expect(mountCalls).toEqual([
        { url: "http://127.0.0.1:1911/", path: "/tmp/envd-mount" },
      ]);
    });
  });

  it("reports provider health failures", async () => {
    await withTempProject(async (projectDir) => {
      const base = healthyStatus(projectDir);
      const result = await doctorProject(
        { path: projectDir },
        {
          getStatus: () =>
            Promise.resolve({
              ...base,
              project:
                base.project === null
                  ? null
                  : {
                      ...base.project,
                      provider: {
                        instanceId: "provider-1",
                        provider: "local-file",
                        name: "personal",
                        healthy: false,
                        error: "provider down",
                      },
                    },
            }),
        },
      );

      expect(check(result, "provider")).toMatchObject({
        status: "error",
        detail: "provider down",
      });
    });
  });
});
