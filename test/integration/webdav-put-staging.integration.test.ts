import { describe, expect, it } from "vitest";
import { request } from "undici";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startWebdavServer,
  type WebdavServerHandle,
} from "../../src/daemon/webdav/server.js";
import { ProjectRepo, type Project } from "../../src/core/project.js";
import { openState, type StateStore } from "../../src/core/state.js";
import { StagingRepo } from "../../src/core/staging.js";

interface StagingRow {
  desired: string;
  updated_at: number;
}

interface WebdavStagingFixture {
  readonly base: string;
  readonly project: Project;
  readonly state: StateStore;
}

const NOW = 2468;

async function withWebdavStaging(
  fn: (fixture: WebdavStagingFixture) => Promise<void>,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "d-env-webdav-put-staging-"));
  const projectDir = join(tempDir, "project");
  mkdirSync(projectDir);

  let server: WebdavServerHandle | undefined;
  let state: StateStore | undefined;

  try {
    state = openState(join(tempDir, "state.db"));
    const projectRepo = new ProjectRepo(state.db);
    const stagingRepo = new StagingRepo(state.db, { now: () => NOW });
    const project = projectRepo.create({ path: projectDir });

    server = await startWebdavServer({
      port: 0,
      projectRepo,
      stagingRepo,
    });

    await fn({
      base: `http://127.0.0.1:${server.port}`,
      project,
      state,
    });
  } finally {
    if (server !== undefined) {
      await server.close();
    }
    state?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function envUrl(base: string, project: Project): string {
  return `${base}/p/${project.id}.${project.token}/.env`;
}

function readStagingRow(state: StateStore, projectId: string): StagingRow {
  const row = state.db
    .prepare<[string], StagingRow>(
      `
      SELECT desired, updated_at
      FROM staging
      WHERE project_id = ?
    `,
    )
    .get(projectId);

  if (row === undefined) {
    throw new Error("expected staging row");
  }

  return row;
}

describe("WebDAV PUT staging integration", () => {
  it("stages the PUT .env body as the full desired state", async () => {
    await withWebdavStaging(async ({ base, project, state }) => {
      const first = await request(envUrl(base, project), {
        method: "PUT",
        body: "OLD=old\nAPI_KEY=abc123\n",
      });
      expect(first.statusCode).toBe(204);
      await first.body.dump();

      const second = await request(envUrl(base, project), {
        method: "PUT",
        body: 'SPACED="hello world"\nEMPTY=\n',
      });
      expect(second.statusCode).toBe(204);
      await second.body.dump();

      const row = readStagingRow(state, project.id);
      const desired = JSON.parse(row.desired) as Record<string, unknown>;
      expect(row.updated_at).toBe(NOW);
      expect(desired).toEqual({
        SPACED: "hello world",
        EMPTY: "",
      });
    });
  });

  it("returns bad_dotenv without replacing staging for invalid .env input", async () => {
    await withWebdavStaging(async ({ base, project, state }) => {
      const good = await request(envUrl(base, project), {
        method: "PUT",
        body: "UNCHANGED=yes\n",
      });
      expect(good.statusCode).toBe(204);
      await good.body.dump();

      const bad = await request(envUrl(base, project), {
        method: "PUT",
        body: "BROKEN\n",
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.headers["x-denv-error"]).toBe("bad_dotenv");
      await bad.body.dump();

      const row = readStagingRow(state, project.id);
      const desired = JSON.parse(row.desired) as Record<string, unknown>;
      expect(desired).toEqual({ UNCHANGED: "yes" });
    });
  });
});
