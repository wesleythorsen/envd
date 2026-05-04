import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRepo } from "../../src/core/project.js";
import { openState } from "../../src/core/state.js";
import { StagingRepo } from "../../src/core/staging.js";

function withRepo(fn: (repo: StagingRepo, projectId: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "d-env-staging-test-"));
  const dbPath = join(dir, "state.db");
  const projectPath = join(dir, "project");
  const store = openState(dbPath);

  try {
    mkdirSync(projectPath);
    const project = new ProjectRepo(store.db).create({ path: projectPath });

    fn(new StagingRepo(store.db, { now: () => 1234 }), project.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("StagingRepo", () => {
  it("returns undefined when no staging exists for a project", () => {
    withRepo((repo, projectId) => {
      expect(repo.getDesired(projectId)).toBeUndefined();
    });
  });

  it("sets and gets desired state", () => {
    withRepo((repo, projectId) => {
      repo.setDesired(projectId, {
        API_KEY: "secret",
        REMOVED: null,
      });

      expect(repo.getDesired(projectId)).toEqual({
        API_KEY: "secret",
        REMOVED: null,
      });
    });
  });

  it("overwrites desired state for the same project", () => {
    withRepo((repo, projectId) => {
      repo.setDesired(projectId, {
        OLD_KEY: "old",
      });

      repo.setDesired(projectId, {
        NEW_KEY: "new",
      });

      expect(repo.getDesired(projectId)).toEqual({
        NEW_KEY: "new",
      });
    });
  });

  it("clears staged desired state", () => {
    withRepo((repo, projectId) => {
      repo.setDesired(projectId, {
        API_KEY: "secret",
      });

      expect(repo.clear(projectId)).toBe(true);
      expect(repo.getDesired(projectId)).toBeUndefined();
      expect(repo.clear(projectId)).toBe(false);
    });
  });
});
