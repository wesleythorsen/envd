import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../");
const cliPath = join(repoRoot, "dist/cli/main.js");

function cliCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15_000);

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      rejectCommand(err);
    });

    child.on("close", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolveCommand({ stdout, stderr, status: code ?? -1 });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      resolveBody(body);
    });
    req.on("error", reject);
  });
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

describe("commit command integration", () => {
  let tmpHome: string;
  let projectDir: string;
  let server: Server;
  let controlPort = 0;
  let commitBodies: Array<Record<string, unknown>>;
  let commitMode: "ok" | "conflict";
  const token = "integration-token";

  beforeAll(() => {
    if (!existsSync(cliPath)) {
      throw new Error(
        `dist/cli/main.js not found — run 'npm run build' first.\nExpected: ${cliPath}`,
      );
    }
  });

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "d-env-commit-cli-"));
    projectDir = join(tmpHome, "project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, ".d-env.json"),
      JSON.stringify({ projectId: "project-1", version: 1 }),
    );
    writeFileSync(join(tmpHome, "control-token"), token);
    commitBodies = [];
    commitMode = "ok";

    server = createServer(async (req, res) => {
      if (req.headers["authorization"] !== `Bearer ${token}`) {
        writeJson(res, 401, {
          error: { code: "unauthorized", message: "Unauthorized" },
        });
        return;
      }

      if (req.method === "GET" && req.url === "/v1/projects/project-1/diff") {
        writeJson(res, 200, {
          keys: { added: ["ADDED"], modified: ["SHARED"], deleted: [] },
        });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/projects/project-1/commit") {
        const body = await readBody(req);
        commitBodies.push((JSON.parse(body) as Record<string, unknown>) ?? {});
        if (commitMode === "conflict") {
          writeJson(res, 409, {
            error: {
              code: "commit_conflict",
              message:
                "Commit conflicts detected; retry with strategy='ours' or strategy='theirs'",
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
          });
          return;
        }

        writeJson(res, 200, {
          applied: {
            upserts: { ADDED: "fresh", SHARED: "local" },
            deletes: [],
          },
          commitId: null,
        });
        return;
      }

      writeJson(res, 404, {
        error: { code: "not_found", message: "Not found" },
      });
    });

    await new Promise<void>((resolveServer, rejectServer) => {
      server.once("error", (err) => {
        rejectServer(err);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address !== null && typeof address === "object") {
          controlPort = address.port;
        }
        writeFileSync(
          join(tmpHome, "ports.json"),
          JSON.stringify({ control: controlPort, webdav: controlPort + 1 }),
        );
        resolveServer();
      });
    });
  });

  afterAll(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolveServer, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolveServer();
      });
    });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("commits through the built CLI and forwards message + default strategy", async () => {
    const result = await cliCommand(
      ["commit", projectDir, "--yes", "-m", "rotate value", "--json"],
      { D_ENV_HOME: tmpHome },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      status: "committed",
      projectId: "project-1",
      applied: {
        upserts: { ADDED: "fresh", SHARED: "local" },
        deletes: [],
      },
      commitId: null,
    });
    expect(commitBodies).toEqual([
      { message: "rotate value", strategy: "abort" },
    ]);
  });

  it("prompts, prints the staged summary, and exits non-zero on conflict", async () => {
    commitMode = "conflict";

    const result = await cliCommand(
      ["commit", projectDir],
      { D_ENV_HOME: tmpHome },
      "y\n",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("About to push these keys:");
    expect(result.stdout).toContain("+ADDED");
    expect(result.stdout).toContain("~SHARED");
    expect(result.stdout).toContain("Commit these staged changes?");
    expect(result.stderr).toContain("Commit conflicts detected");
    expect(result.stderr).toContain("Conflicting keys:");
    expect(result.stderr).toContain("SHARED");
    expect(result.stderr).toContain("d-env commit --ours");
    expect(result.stderr).toContain("d-env commit --theirs");
    expect(commitBodies).toEqual([{ strategy: "abort" }]);
  });
});
