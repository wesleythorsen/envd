import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPullCommand } from "../../src/cli/commands/pull.js";
import type {
  ControlClient,
  ProjectDiffResult,
  ProjectPullResult,
} from "../../src/ipc/control-client.js";

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "d-env-pull-test-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  writeFileSync(
    join(projectDir, ".d-env.json"),
    JSON.stringify({ projectId: "project-1", version: 1 }),
  );
  return fn(projectDir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function fakeClient(): ControlClient & {
  readonly pullCalls: Array<{ id: string; force?: boolean }>;
  readonly diffCalls: string[];
} {
  const pullCalls: Array<{ id: string; force?: boolean }> = [];
  const diffCalls: string[] = [];
  const diffResult: ProjectDiffResult = {
    keys: { added: ["ADDED"], modified: ["MODIFIED"], deleted: ["DELETED"] },
  };
  const pullResult: ProjectPullResult = {
    snapshotFetchedAt: 123_456,
  };

  return {
    pullCalls,
    diffCalls,
    health: () => Promise.resolve({ ok: true, version: "test", uptimeSec: 0 }),
    version: () =>
      Promise.resolve({ cli: null, daemon: "test", protocol: "v1" }),
    createProject: () => Promise.reject(new Error("not needed")),
    getProject: () => Promise.reject(new Error("not needed")),
    getProjectDiff: (id) => {
      diffCalls.push(id);
      return Promise.resolve(diffResult);
    },
    pullProject: (id, opts) => {
      pullCalls.push({ id, force: opts?.force });
      return Promise.resolve(pullResult);
    },
    deleteProject: () => Promise.resolve(),
    listProviders: () => Promise.resolve([]),
    createProviderInstance: () => Promise.reject(new Error("not needed")),
    listProviderInstances: () => Promise.resolve([]),
    getProviderInstance: () => Promise.reject(new Error("not needed")),
    deleteProviderInstance: () => Promise.resolve(),
    testProviderInstance: () => Promise.resolve({ ok: true }),
    shutdown: () => Promise.resolve(),
  };
}

async function runPull(
  args: readonly string[],
  client: ControlClient,
): Promise<string> {
  let stdout = "";
  const command = buildPullCommand({
    client,
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
    },
  });

  await command.parseAsync([...args], { from: "user" });
  return stdout;
}

describe("pull command", () => {
  it("calls the pull endpoint and prints a success message", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient();

      const stdout = await runPull([projectDir], client);

      expect(stdout).toBe("d-env pulled (snapshot fetched at 123456)\n");
      expect(client.pullCalls).toEqual([{ id: "project-1", force: false }]);
      expect(client.diffCalls).toEqual([]);
    });
  });

  it("passes --force through to the pull endpoint", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient();

      await runPull([projectDir, "--force"], client);

      expect(client.pullCalls).toEqual([{ id: "project-1", force: true }]);
      expect(client.diffCalls).toEqual([]);
    });
  });

  it("uses the diff endpoint for --dry-run without calling pull", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient();

      const stdout = await runPull([projectDir, "--dry-run"], client);

      expect(stdout).toBe(
        "Pull would discard staged changes:\n+ADDED\n~MODIFIED\n-DELETED\n",
      );
      expect(client.pullCalls).toEqual([]);
      expect(client.diffCalls).toEqual(["project-1"]);
    });
  });

  it("prints JSON output for --json dry runs", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient();

      const stdout = await runPull([projectDir, "--dry-run", "--json"], client);

      expect(JSON.parse(stdout) as unknown).toEqual({
        status: "dry_run",
        projectId: "project-1",
        diff: {
          keys: {
            added: ["ADDED"],
            modified: ["MODIFIED"],
            deleted: ["DELETED"],
          },
        },
      });
      expect(client.pullCalls).toEqual([]);
      expect(client.diffCalls).toEqual(["project-1"]);
    });
  });
});
