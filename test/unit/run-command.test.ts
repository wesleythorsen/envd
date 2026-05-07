import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRunInvocation, runProject } from "../../src/cli/commands/run.js";
import type {
  ProjectEnvironmentValuesOptions,
  ProjectEnvironmentValuesResult,
} from "../../src/ipc/control-client.js";
import { EnvdError } from "../../src/shared/errors.js";
import { registerProject } from "../../src/cli/config-file.js";

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-run-command-"));
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

describe("run command helpers", () => {
  it("parses explicit and active-environment invocations around --", () => {
    expect(parseRunInvocation(["dev", "--", "npm", "run", "dev"])).toEqual({
      environment: "dev",
      command: ["npm", "run", "dev"],
    });
    expect(parseRunInvocation(["--", "npm", "run", "dev"])).toEqual({
      command: ["npm", "run", "dev"],
    });
  });

  it("injects secrets from the requested environment into the child process", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const readCalls: Array<{
        readonly id: string;
        readonly opts?: ProjectEnvironmentValuesOptions;
      }> = [];
      const spawnCalls: Array<{
        readonly command: string;
        readonly args: readonly string[];
        readonly env: NodeJS.ProcessEnv;
      }> = [];

      const result = await runProject(
        { environment: "dev", command: ["node", "server.js"] },
        { path: projectDir },
        {
          readEnvironment: (id, opts) => {
            readCalls.push({ id, opts });
            return Promise.resolve({
              environment: opts?.environment ?? "default",
              values: { API_KEY: "secret-value", NODE_ENV: "development" },
            });
          },
          spawnCommand: (command, args, env) => {
            spawnCalls.push({ command, args, env });
            return Promise.resolve(0);
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(readCalls).toEqual([
        { id: "project-1", opts: { environment: "dev" } },
      ]);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.command).toBe("node");
      expect(spawnCalls[0]?.args).toEqual(["server.js"]);
      expect(spawnCalls[0]?.env["API_KEY"]).toBe("secret-value");
      expect(spawnCalls[0]?.env["NODE_ENV"]).toBe("development");
    });
  });

  it("uses the active environment when none is provided", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const readCalls: ProjectEnvironmentValuesOptions[] = [];

      await runProject(
        { command: ["printenv"] },
        { path: projectDir },
        {
          readEnvironment: (_id, opts) => {
            readCalls.push(opts ?? {});
            return Promise.resolve({
              environment: "default",
              values: {},
            });
          },
          spawnCommand: () => Promise.resolve(0),
        },
      );

      expect(readCalls).toEqual([{ environment: "default" }]);
    });
  });

  it("surfaces provider/read failures before spawning the child", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      let spawnCalled = false;

      await expect(
        runProject(
          { environment: "dev", command: ["node"] },
          { path: projectDir },
          {
            readEnvironment: () =>
              Promise.reject(
                new EnvdError("provider unavailable", {
                  code: "provider_unreachable",
                }),
              ),
            spawnCommand: () => {
              spawnCalled = true;
              return Promise.resolve(0);
            },
          },
        ),
      ).rejects.toMatchObject({ code: "provider_unreachable" });
      expect(spawnCalled).toBe(false);
    });
  });

  it("returns the child exit code without logging secret values", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const rendered: ProjectEnvironmentValuesResult = {
        environment: "dev",
        values: { TOKEN: "do-not-log" },
      };

      const result = await runProject(
        { environment: "dev", command: ["false"] },
        { path: projectDir },
        {
          readEnvironment: () => Promise.resolve(rendered),
          spawnCommand: () => Promise.resolve(42),
        },
      );

      expect(result).toEqual({
        status: "exited",
        projectId: "project-1",
        environment: "dev",
        exitCode: 42,
      });
      expect(JSON.stringify(result)).not.toContain("do-not-log");
    });
  });
});
