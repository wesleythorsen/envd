import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/cli/commands/init.js";
import {
  generateToken,
  startControlServer,
  type ControlServerHandle,
} from "../../src/daemon/control/server.js";
import { ProjectRepo } from "../../src/core/project.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { openState, type StateStore } from "../../src/core/state.js";
import {
  createControlClient,
  type ControlClient,
} from "../../src/ipc/control-client.js";

interface InitServerFixture {
  readonly client: ControlClient;
  readonly projectDir: string;
  readonly secretsPath: string;
}

async function withInitServer(
  fn: (fixture: InitServerFixture) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "d-env-init-provider-"));
  const projectDir = join(tempDir, "project");
  const secretsPath = join(tempDir, "secrets.json");
  mkdirSync(projectDir);

  const token = generateToken();
  let server: ControlServerHandle | undefined;
  let state: StateStore | undefined;
  try {
    state = openState(join(tempDir, "state.db"));
    server = await startControlServer({
      port: 0,
      token,
      projectRepo: new ProjectRepo(state.db),
      providerInstanceRepo: new ProviderInstanceRepo(state.db),
    });
    const client = createControlClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token,
    });
    await fn({ client, projectDir, secretsPath });
  } finally {
    if (server !== undefined) {
      await server.close();
    }
    state?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("init provider instance integration", () => {
  it("uses scripted input to select an existing provider instance", async () => {
    await withInitServer(async ({ client, projectDir, secretsPath }) => {
      const providerInstance = await client.createProviderInstance({
        provider: "local-file",
        name: "Local secrets",
        config: { path: secretsPath },
        credentials: {},
      });
      const prompts: string[] = [];

      const result = await initProject(
        projectDir,
        { yes: true },
        {
          client,
          ensureMount: false,
          prompt: (question) => {
            prompts.push(question);
            return Promise.resolve("1");
          },
        },
      );

      const project = await client.getProject(result.projectId);
      expect(project.providerInstanceId).toBe(providerInstance.id);
      expect(prompts).toEqual([
        `Choose provider instance:\n1) Local secrets (local-file, ${providerInstance.id})\n2) Create new\nSelection`,
      ]);
    });
  });

  it("auto-creates a provider instance from non-interactive flags", async () => {
    await withInitServer(async ({ client, projectDir, secretsPath }) => {
      const result = await initProject(
        projectDir,
        {
          yes: true,
          provider: "local-file",
          providerInstanceName: "CI local",
          configJson: JSON.stringify({ path: secretsPath }),
          credentialsJson: "{}",
        },
        {
          client,
          ensureMount: false,
          prompt: () => Promise.reject(new Error("unexpected prompt")),
        },
      );

      const instances = await client.listProviderInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0]).toMatchObject({
        provider: "local-file",
        name: "CI local",
        config: { path: secretsPath },
      });
      const project = await client.getProject(result.projectId);
      expect(project.providerInstanceId).toBe(instances[0]?.id);
    });
  });
});
