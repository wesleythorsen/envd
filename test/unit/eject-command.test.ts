import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ejectProject } from "../../src/cli/commands/eject.js";
import type { ProjectEnvironmentValuesOptions } from "../../src/ipc/control-client.js";
import { readEnvdConfig, registerProject } from "../../src/cli/config-file.js";

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-eject-command-"));
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

function registerTestProject(projectDir: string): void {
  registerProject({
    id: "project-1",
    root: projectDir,
    providerInstanceId: "provider-1",
    activeEnvironment: "default",
    environments: [
      { name: "default", providerEnvironment: "default" },
      { name: "dev", providerEnvironment: "dev" },
    ],
  });
}

function linkManagedEnv(projectDir: string): void {
  symlinkSync(
    "/tmp/envd-mount/p/project-1.token/.env",
    join(projectDir, ".env"),
  );
}

describe("eject command helpers", () => {
  it("recreates ordinary env files from committed provider values", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      linkManagedEnv(projectDir);
      const readCalls: Array<{
        readonly id: string;
        readonly opts?: ProjectEnvironmentValuesOptions;
      }> = [];
      let stdout = "";

      const result = await ejectProject(
        { path: projectDir, yes: true },
        {
          readEnvironment: (id, opts) => {
            readCalls.push({ id, opts });
            return Promise.resolve({
              environment: opts?.environment ?? "default",
              values:
                opts?.environment === "dev" ? { DEV: "1" } : { DEFAULT: "1" },
            });
          },
          stdout: {
            write(chunk: string) {
              stdout += chunk;
              return true;
            },
          },
        },
      );

      expect(result.files.map((file) => file.path).sort()).toEqual([
        join(projectDir, ".env"),
        join(projectDir, ".env.dev"),
      ]);
      expect(readCalls).toEqual([
        {
          id: "project-1",
          opts: { environment: "default", includeStaging: false },
        },
        {
          id: "project-1",
          opts: { environment: "dev", includeStaging: false },
        },
      ]);
      expect(readFileSync(join(projectDir, ".env"), "utf-8")).toBe(
        "DEFAULT=1\n",
      );
      expect(readFileSync(join(projectDir, ".env.dev"), "utf-8")).toBe(
        "DEV=1\n",
      );
      expect(readEnvdConfig().projects).toEqual([]);
      expect(stdout).toContain("envd eject will recreate:");
    });
  });

  it("restores exact pre-adoption files from the retired receipt", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      linkManagedEnv(projectDir);
      const retiredEnv = join(projectDir, ".envd-retired", "stamp", ".env");
      const retiredDev = join(projectDir, ".envd-retired", "stamp", ".env.dev");
      mkdirSync(dirname(retiredEnv), { recursive: true });
      writeFileSync(retiredEnv, "EXACT='quoted value'\n", "utf-8");
      writeFileSync(retiredDev, "DEV=original\n", "utf-8");
      writeFileSync(
        join(projectDir, ".envd-retired", "stamp", "receipt.json"),
        JSON.stringify({
          files: [
            {
              originalPath: join(projectDir, ".env"),
              retiredPath: retiredEnv,
              environment: "default",
              keyCount: 1,
            },
            {
              originalPath: join(projectDir, ".env.dev"),
              retiredPath: retiredDev,
              environment: "dev",
              keyCount: 1,
            },
          ],
        }),
        "utf-8",
      );

      await ejectProject(
        { path: projectDir, yes: true, fromRetired: true },
        {
          readEnvironment: () => Promise.reject(new Error("not needed")),
        },
      );

      expect(readFileSync(join(projectDir, ".env"), "utf-8")).toBe(
        "EXACT='quoted value'\n",
      );
      expect(readFileSync(join(projectDir, ".env.dev"), "utf-8")).toBe(
        "DEV=original\n",
      );
    });
  });

  it("removes the managed symlink, local registration, and purges state when requested", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      linkManagedEnv(projectDir);
      const deletedProjects: string[] = [];

      const result = await ejectProject(
        { path: projectDir, yes: true, purge: true },
        {
          client: {
            deleteProject: (id) => {
              deletedProjects.push(id);
              return Promise.resolve();
            },
          },
          readEnvironment: (_id, opts) =>
            Promise.resolve({
              environment: opts?.environment ?? "default",
              values: {},
            }),
        },
      );

      expect(existsSync(join(projectDir, ".env"))).toBe(true);
      expect(() => readlinkSync(join(projectDir, ".env"))).toThrow();
      expect(readEnvdConfig().projects).toEqual([]);
      expect(deletedProjects).toEqual(["project-1"]);
      expect(result.purged).toBe(true);
    });
  });
});
