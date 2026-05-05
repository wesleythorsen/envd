import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCommitCommand } from "../../src/cli/commands/commit.js";
import type {
  ControlClient,
  ProjectCommitResult,
  ProjectDiffResult,
  ProjectCommitStrategy,
} from "../../src/ipc/control-client.js";
import { DEnvError } from "../../src/shared/errors.js";

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "d-env-commit-test-"));
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

function fakeClient(opts: {
  readonly diffResult?: ProjectDiffResult;
  readonly commitImpl?: (
    id: string,
    input: { readonly message?: string; readonly strategy?: ProjectCommitStrategy },
  ) => Promise<ProjectCommitResult>;
} = {}): ControlClient & {
  readonly diffCalls: string[];
  readonly commitCalls: Array<{
    readonly id: string;
    readonly message?: string;
    readonly strategy?: ProjectCommitStrategy;
  }>;
} {
  const diffCalls: string[] = [];
  const commitCalls: Array<{
    readonly id: string;
    readonly message?: string;
    readonly strategy?: ProjectCommitStrategy;
  }> = [];
  const diffResult =
    opts.diffResult ??
    ({
      keys: { added: ["ADDED"], modified: ["CHANGED"], deleted: ["DELETED"] },
    } satisfies ProjectDiffResult);

  return {
    diffCalls,
    commitCalls,
    health: () => Promise.resolve({ ok: true, version: "test", uptimeSec: 0 }),
    version: () =>
      Promise.resolve({ cli: null, daemon: "test", protocol: "v1" }),
    createProject: () => Promise.reject(new Error("not needed")),
    getProject: () => Promise.reject(new Error("not needed")),
    getProjectStatus: () => Promise.reject(new Error("not needed")),
    getProjectDiff: (id) => {
      diffCalls.push(id);
      return Promise.resolve(diffResult);
    },
    commitProject: (id, input) => {
      commitCalls.push({ id, ...input });
      if (opts.commitImpl !== undefined) {
        return opts.commitImpl(id, input);
      }
      return Promise.resolve({
        applied: { upserts: { ADDED: "fresh" }, deletes: ["DELETED"] },
        commitId: null,
      });
    },
    pullProject: () => Promise.reject(new Error("not needed")),
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

async function runCommit(
  args: readonly string[],
  client: ControlClient,
  opts: {
    readonly confirm?: (question: string) => Promise<boolean>;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(
    ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit:${code ?? 0}`);
    }) as (code?: string | number | null | undefined) => never,
  );

  const command = buildCommitCommand({
    client,
    confirm: opts.confirm,
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
    },
  });

  try {
    await command.parseAsync([...args], { from: "user" });
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("process.exit:")
    ) {
      throw error;
    }
  } finally {
    exitSpy.mockRestore();
  }

  return { stdout, stderr, exitCode };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commit command", () => {
  it("prints a staged summary, confirms, and commits with the default abort strategy", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient();
      const confirm = vi.fn<(question: string) => Promise<boolean>>();
      confirm.mockResolvedValue(true);

      const result = await runCommit(
        [projectDir, "-m", "rotate value"],
        client,
        { confirm },
      );

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        "About to push these keys:\n+ADDED\n~CHANGED\n-DELETED\n" +
          "d-env committed (upserts=1, deletes=1)\n",
      );
      expect(confirm).toHaveBeenCalledWith("Commit these staged changes?");
      expect(client.diffCalls).toEqual(["project-1"]);
      expect(client.commitCalls).toEqual([
        {
          id: "project-1",
          message: "rotate value",
          strategy: "abort",
        },
      ]);
    });
  });

  it("skips confirmation and forwards --theirs with --yes", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient();
      const confirm = vi.fn<(question: string) => Promise<boolean>>();

      const result = await runCommit(
        [projectDir, "--yes", "--theirs"],
        client,
        { confirm },
      );

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toBe("d-env committed (upserts=1, deletes=1)\n");
      expect(confirm).not.toHaveBeenCalled();
      expect(client.diffCalls).toEqual([]);
      expect(client.commitCalls).toEqual([
        {
          id: "project-1",
          strategy: "theirs",
        },
      ]);
    });
  });

  it("prints JSON output and forwards --ours", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient();

      const result = await runCommit(
        [projectDir, "--yes", "--json", "--ours"],
        client,
      );

      expect(result.exitCode).toBeUndefined();
      expect(JSON.parse(result.stdout) as unknown).toEqual({
        status: "committed",
        projectId: "project-1",
        applied: {
          upserts: { ADDED: "fresh" },
          deletes: ["DELETED"],
        },
        commitId: null,
      });
      expect(client.commitCalls).toEqual([
        {
          id: "project-1",
          strategy: "ours",
        },
      ]);
    });
  });

  it("prints conflict guidance and exits non-zero when the commit conflicts", async () => {
    await withTempProject(async (projectDir) => {
      const client = fakeClient({
        commitImpl: () =>
          Promise.reject(
            new DEnvError(
              "Commit conflicts detected; retry with strategy='ours' or strategy='theirs'",
              {
                code: "commit_conflict",
                details: {
                  conflicts: [
                    {
                      key: "SHARED",
                      base: "base",
                      remote: "remote",
                      desired: "local",
                    },
                  ],
                },
              },
            ),
          ),
      });

      const result = await runCommit([projectDir], client, {
        confirm: () => Promise.resolve(true),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Commit conflicts detected");
      expect(result.stderr).toContain("Conflicting keys:\n  SHARED\n");
      expect(result.stderr).toContain("d-env commit --ours");
      expect(result.stderr).toContain("d-env commit --theirs");
    });
  });
});
