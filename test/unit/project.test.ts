import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openState } from "../../src/core/state.js";
import { ProjectRepo } from "../../src/core/project.js";
import { DEnvError } from "../../src/shared/errors.js";

function withRepo(fn: (repo: ProjectRepo, projectPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "d-env-project-test-"));
  const dbPath = join(dir, "state.db");
  const projectPath = join(dir, "project");

  const store = openState(dbPath);
  try {
    const repo = new ProjectRepo(store.db);
    fn(repo, projectPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ProjectRepo", () => {
  it("creates and reads a project", () => {
    withRepo((repo, projectPath) => {
      mkdirSync(projectPath);

      const project = repo.create({ path: projectPath });

      expect(project.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(project.token).toMatch(/^[0-9a-f]{64}$/);
      expect(project.path).toBe(projectPath);
      expect(project.format).toBe("dotenv");
      expect(project.formatConfig).toBe("{}");

      expect(repo.get(project.id)).toEqual(project);
    });
  });

  it("gets a project by id and matching token", () => {
    withRepo((repo, projectPath) => {
      mkdirSync(projectPath);
      const project = repo.create({ path: projectPath });

      expect(repo.getByToken(project.id, project.token)).toEqual(project);
      expect(repo.getByToken(project.id, "wrong")).toBeUndefined();
      expect(repo.getByToken("unknown", project.token)).toBeUndefined();
    });
  });

  it("lists projects in creation order", () => {
    withRepo((repo, projectPath) => {
      const firstPath = join(projectPath, "first");
      const secondPath = join(projectPath, "second");
      mkdirSync(firstPath, { recursive: true });
      mkdirSync(secondPath);

      const first = repo.create({ path: firstPath });
      const second = repo.create({ path: secondPath });

      expect(repo.list().map((project) => project.id)).toEqual([
        first.id,
        second.id,
      ]);
    });
  });

  it("deletes projects by id", () => {
    withRepo((repo, projectPath) => {
      mkdirSync(projectPath);
      const project = repo.create({ path: projectPath });

      expect(repo.delete(project.id)).toBe(true);
      expect(repo.get(project.id)).toBeUndefined();
      expect(repo.delete(project.id)).toBe(false);
    });
  });

  it("rejects non-absolute paths", () => {
    withRepo((repo) => {
      expect(() => {
        repo.create({ path: "relative/path" });
      }).toThrow(DEnvError);
    });
  });

  it("rejects missing paths", () => {
    withRepo((repo, projectPath) => {
      expect(() => {
        repo.create({ path: projectPath });
      }).toThrow(DEnvError);
    });
  });
});
