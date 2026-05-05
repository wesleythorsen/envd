import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request } from "undici";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startControlServer,
  generateToken,
  type ControlServerHandle,
} from "../../src/daemon/control/server.js";
import {
  startWebdavServer,
  type WebdavServerHandle,
} from "../../src/daemon/webdav/server.js";
import { openState, type StateStore } from "../../src/core/state.js";
import { ProjectRepo, type Project } from "../../src/core/project.js";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { StagingRepo } from "../../src/core/staging.js";
import {
  resetLogWriter,
  setLogWriter,
} from "../../src/shared/logger.js";

function expectSecretRedacted(logs: string, secret: string): void {
  expect(logs).not.toContain(secret);
  expect(logs).not.toContain(JSON.stringify(secret).slice(1, -1));
}

describe("log redaction guardrails", () => {
  let tempDir: string;
  let state: StateStore;
  let projectRepo: ProjectRepo;
  let providerInstanceRepo: ProviderInstanceRepo;
  let stagingRepo: StagingRepo;
  let project: Project;
  let controlServer: ControlServerHandle | undefined;
  let webdavServer: WebdavServerHandle | undefined;
  let controlBase: string;
  let webdavBase: string;
  let controlToken: string;
  let logs: string[];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "d-env-log-redaction-test-"));
    process.env["D_ENV_LOG_LEVEL"] = "debug";
    process.env["D_ENV_LOG_FORMAT"] = "json";
    logs = [];
    setLogWriter((line) => {
      logs.push(line);
    });

    const projectPath = join(tempDir, "project");
    const secondProjectPath = join(tempDir, "second-project");
    const providerFile = join(tempDir, "provider.json");
    mkdirSync(projectPath);
    mkdirSync(secondProjectPath);
    writeFileSync(providerFile, JSON.stringify({ API_KEY: "safe-value" }));

    state = openState(join(tempDir, "state.db"));
    projectRepo = new ProjectRepo(state.db);
    providerInstanceRepo = new ProviderInstanceRepo(state.db);
    stagingRepo = new StagingRepo(state.db);

    const providerInstance = providerInstanceRepo.create({
      provider: "local-file",
      name: "Redaction fixture",
      config: JSON.stringify({ path: providerFile }),
    });

    project = projectRepo.create({
      path: projectPath,
      providerInstanceId: providerInstance.id,
    });

    controlToken = generateToken();
    controlServer = await startControlServer({
      port: 0,
      token: controlToken,
      projectRepo,
      providerInstanceRepo,
      stagingRepo,
    });
    webdavServer = await startWebdavServer({
      port: 0,
      projectRepo,
      providerInstanceRepo,
      stagingRepo,
    });
    controlBase = `http://127.0.0.1:${controlServer.port}`;
    webdavBase = `http://127.0.0.1:${webdavServer.port}`;
  });

  afterEach(async () => {
    resetLogWriter();
    delete process.env["D_ENV_LOG_LEVEL"];
    delete process.env["D_ENV_LOG_FORMAT"];

    if (controlServer !== undefined) {
      await controlServer.close();
    }
    if (webdavServer !== undefined) {
      await webdavServer.close();
    }
    state.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not emit secret-looking path segments, body values, or project tokens", async () => {
    const pathSecret = "password=hunter2";
    const quotedSecret = 'with "quotes"';
    const secondProjectPath = join(tempDir, "second-project");

    const controlUnknown = await request(
      `${controlBase}/v1/nope/${encodeURIComponent(pathSecret)}`,
      {
        headers: { Authorization: `Bearer ${controlToken}` },
      },
    );
    expect(controlUnknown.statusCode).toBe(404);
    await controlUnknown.body.dump();

    const createProject = await request(`${controlBase}/v1/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controlToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: secondProjectPath,
        formatConfig: JSON.stringify({ note: quotedSecret }),
      }),
    });
    expect(createProject.statusCode).toBe(201);
    await createProject.body.dump();

    const invalidWebdav = await request(
      `${webdavBase}/p/${project.id}.${pathSecret}/.env`,
    );
    expect(invalidWebdav.statusCode).toBe(404);
    await invalidWebdav.body.dump();

    const validWebdav = await request(
      `${webdavBase}/p/${project.id}.${project.token}/.env`,
    );
    expect(validWebdav.statusCode).toBe(200);
    await validWebdav.body.dump();

    const putBody = `PASSWORD=${pathSecret}\nQUOTED="${quotedSecret.replace(/"/gu, '\\"')}"\n`;
    const putRes = await request(
      `${webdavBase}/p/${project.id}.${project.token}/.env`,
      {
        method: "PUT",
        body: putBody,
      },
    );
    expect(putRes.statusCode).toBe(204);
    await putRes.body.dump();

    const captured = logs.join("");
    expect(captured).toContain('"/v1/*"');
    expect(captured).toContain('"/p/:project/.env"');
    expectSecretRedacted(captured, pathSecret);
    expectSecretRedacted(captured, quotedSecret);
    expectSecretRedacted(captured, project.token);
  });
});
