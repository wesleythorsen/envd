import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { openState } from "../../src/core/state.js";
import { ProjectRepo } from "../../src/core/project.js";
import { DEnvError } from "../../src/shared/errors.js";

function withRepos(
  fn: (
    repo: ProjectRepo,
    providerInstanceRepo: ProviderInstanceRepo,
    projectPath: string,
  ) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "d-env-project-test-"));
  const dbPath = join(dir, "state.db");
  const projectPath = join(dir, "project");

  const store = openState(dbPath);
  try {
    fn(
      new ProjectRepo(store.db),
      new ProviderInstanceRepo(store.db),
      projectPath,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ProjectRepo", () => {
  it("creates and reads a project", () => {
    withRepos((repo, _providerInstanceRepo, projectPath) => {
      mkdirSync(projectPath);

      const project = repo.create({ path: projectPath });

      expect(project.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(project.token).toMatch(/^[0-9a-f]{64}$/);
      expect(project.path).toBe(projectPath);
      expect(project.providerInstanceId).toBeNull();
      expect(project.format).toBe("dotenv");
      expect(project.formatConfig).toBe(
        JSON.stringify({ quote: "when-needed", sortKeys: "alphabetical" }),
      );

      expect(repo.get(project.id)).toEqual(project);
    });
  });

  it("stores the linked provider instance id when supplied", () => {
    withRepos((repo, providerInstanceRepo, projectPath) => {
      mkdirSync(projectPath);
      const providerInstance = providerInstanceRepo.create({
        provider: "local-file",
        name: "Project secrets",
      });

      const project = repo.create({
        path: projectPath,
        providerInstanceId: providerInstance.id,
      });

      expect(project.providerInstanceId).toBe(providerInstance.id);
      expect(repo.get(project.id)?.providerInstanceId).toBe(
        providerInstance.id,
      );
    });
  });

  it("gets a project by id and matching token", () => {
    withRepos((repo, _providerInstanceRepo, projectPath) => {
      mkdirSync(projectPath);
      const project = repo.create({ path: projectPath });

      expect(repo.getByToken(project.id, project.token)).toEqual(project);
      expect(repo.getByToken(project.id, "wrong")).toBeUndefined();
      expect(repo.getByToken("unknown", project.token)).toBeUndefined();
    });
  });

  it("lists projects in creation order", () => {
    withRepos((repo, _providerInstanceRepo, projectPath) => {
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
    withRepos((repo, _providerInstanceRepo, projectPath) => {
      mkdirSync(projectPath);
      const project = repo.create({ path: projectPath });

      expect(repo.delete(project.id)).toBe(true);
      expect(repo.get(project.id)).toBeUndefined();
      expect(repo.delete(project.id)).toBe(false);
    });
  });

  it("rejects non-absolute paths", () => {
    withRepos((repo) => {
      expect(() => {
        repo.create({ path: "relative/path" });
      }).toThrow(DEnvError);
    });
  });

  it("rejects missing paths", () => {
    withRepos((repo, _providerInstanceRepo, projectPath) => {
      expect(() => {
        repo.create({ path: projectPath });
      }).toThrow(DEnvError);
    });
  });

  it("rejects unknown provider instance ids", () => {
    withRepos((repo, _providerInstanceRepo, projectPath) => {
      mkdirSync(projectPath);

      expect(() => {
        repo.create({
          path: projectPath,
          providerInstanceId: "missing-provider-instance",
        });
      }).toThrow(DEnvError);
    });
  });
});
