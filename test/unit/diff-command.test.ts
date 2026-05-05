import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDiffCommand } from "../../src/cli/commands/diff.js";
import type {
  ControlClient,
  ProjectDiffResult,
} from "../../src/ipc/control-client.js";

const diffFixture: ProjectDiffResult = {
  keys: {
    added: ["ADDED"],
    modified: ["MODIFIED"],
    deleted: ["DELETED"],
  },
  values: {
    added: { ADDED: "fresh" },
    modified: { MODIFIED: { before: "old", after: "new" } },
    deleted: { DELETED: "gone" },
  },
};

function fakeClient(result: ProjectDiffResult): ControlClient {
  return {
    health: () => Promise.resolve({ ok: true, version: "test", uptimeSec: 0 }),
    version: () =>
      Promise.resolve({ cli: null, daemon: "test", protocol: "v1" }),
    createProject: () => Promise.reject(new Error("not needed")),
    getProject: () => Promise.reject(new Error("not needed")),
    getProjectDiff: () => Promise.resolve(result),
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

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "d-env-diff-test-"));
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

async function runDiff(
  args: readonly string[],
  client: ControlClient,
): Promise<string> {
  let stdout = "";
  const command = buildDiffCommand({
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

describe("diff command", () => {
  it("prints keys only by default with git-style prefixes", async () => {
    await withTempProject(async (projectDir) => {
      let requestedValues: boolean | undefined;
      const client = fakeClient({
        keys: diffFixture.keys,
      });
      client.getProjectDiff = (_id, opts) => {
        requestedValues = opts?.values;
        return Promise.resolve({ keys: diffFixture.keys });
      };

      const stdout = await runDiff([projectDir], client);

      expect(requestedValues).toBe(false);
      expect(stdout).toBe("+ADDED\n~MODIFIED\n-DELETED\n");
      expect(stdout).not.toContain("fresh");
      expect(stdout).not.toContain("old");
      expect(stdout).not.toContain("gone");
    });
  });

  it("reveals values with --values", async () => {
    await withTempProject(async (projectDir) => {
      let requestedValues: boolean | undefined;
      const client = fakeClient(diffFixture);
      client.getProjectDiff = (_id, opts) => {
        requestedValues = opts?.values;
        return Promise.resolve(diffFixture);
      };

      const stdout = await runDiff([projectDir, "--values"], client);

      expect(requestedValues).toBe(true);
      expect(stdout).toBe(
        "+ADDED=fresh\n~MODIFIED=old -> new\n-DELETED=gone\n",
      );
    });
  });

  it("prints structured output with --json", async () => {
    await withTempProject(async (projectDir) => {
      const stdout = await runDiff(
        [projectDir, "--json", "--values"],
        fakeClient(diffFixture),
      );

      expect(JSON.parse(stdout) as unknown).toEqual(diffFixture);
    });
  });
});
