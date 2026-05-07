import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browse, formatBrowseHuman } from "../../src/cli/commands/browse.js";
import type { ProjectEnvironmentValuesOptions } from "../../src/ipc/control-client.js";
import { registerProject, writeEnvdConfig } from "../../src/cli/config-file.js";

function withTempProject(
  fn: (projectDir: string, homeDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-browse-command-"));
  mkdirSync(join(dir, "project"));
  const projectDir = realpathSync.native(join(dir, "project"));
  const previousHome = process.env["ENVD_HOME"];
  process.env["ENVD_HOME"] = dir;
  return fn(projectDir, dir).finally(() => {
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

describe("browse command helpers", () => {
  it("lists provider instances and projects outside an initialized project", async () => {
    await withTempProject(async (projectDir, homeDir) => {
      writeEnvdConfig({
        schemaVersion: 1,
        providerInstances: [
          { id: "provider-1", name: "personal", provider: "envd" },
        ],
        projects: [
          {
            id: "project-1",
            root: projectDir,
            providerInstanceId: "provider-1",
            activeEnvironment: "default",
            environments: [
              {
                name: "default",
                providerEnvironment: "default",
              },
            ],
          },
        ],
      });

      const result = await browse(undefined, { path: homeDir });

      expect(result.scope).toBe("config");
      expect(formatBrowseHuman(result)).toContain("personal (envd)");
      expect(formatBrowseHuman(result)).toContain(projectDir);
    });
  });

  it("lists project environments with key counts", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const readCalls: ProjectEnvironmentValuesOptions[] = [];

      const result = await browse(
        undefined,
        { path: projectDir },
        {
          client: {
            listProjectEnvironments: () =>
              Promise.resolve([
                {
                  projectId: "project-1",
                  name: "default",
                  providerEnvironment: "default",
                  createdAt: 1,
                  updatedAt: 1,
                },
                {
                  projectId: "project-1",
                  name: "dev",
                  providerEnvironment: "dev",
                  createdAt: 1,
                  updatedAt: 1,
                },
              ]),
          },
          readEnvironment: (_id, opts) => {
            readCalls.push(opts ?? {});
            return Promise.resolve({
              environment: opts?.environment ?? "default",
              values:
                opts?.environment === "dev"
                  ? { DEV: "1", SHARED: "2" }
                  : { DEFAULT: "1" },
            });
          },
        },
      );

      expect(result).toMatchObject({
        scope: "project",
        projectId: "project-1",
        environments: [
          { name: "default", keyCount: 1 },
          { name: "dev", keyCount: 2 },
        ],
      });
      expect(readCalls).toEqual([
        { environment: "default" },
        { environment: "dev" },
      ]);
    });
  });

  it("hides values unless reveal is explicit", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const deps = {
        readEnvironment: () =>
          Promise.resolve({
            environment: "dev",
            values: { API_KEY: "secret-value" },
          }),
      };

      const hidden = await browse("dev", { path: projectDir }, deps);
      const revealed = await browse(
        "dev",
        { path: projectDir, reveal: true },
        deps,
      );

      expect(JSON.stringify(hidden)).not.toContain("secret-value");
      expect(formatBrowseHuman(hidden)).toContain("Values: hidden");
      expect(formatBrowseHuman(hidden)).not.toContain("secret-value");
      expect(JSON.stringify(revealed)).toContain("secret-value");
      expect(formatBrowseHuman(revealed)).toContain("API_KEY=secret-value");
    });
  });
});
