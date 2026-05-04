import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderInstanceRepo } from "../../src/core/provider-instance.js";
import { ProjectRepo } from "../../src/core/project.js";
import { openState } from "../../src/core/state.js";
import { DEnvError } from "../../src/shared/errors.js";

function withRepos(
  fn: (
    providerInstanceRepo: ProviderInstanceRepo,
    projectRepo: ProjectRepo,
    projectPath: string,
  ) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "d-env-provider-instance-test-"));
  const dbPath = join(dir, "state.db");
  const projectPath = join(dir, "project");
  const store = openState(dbPath);

  try {
    fn(
      new ProviderInstanceRepo(store.db),
      new ProjectRepo(store.db),
      projectPath,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ProviderInstanceRepo", () => {
  it("creates, lists, gets, and deletes provider instances", () => {
    withRepos((providerInstanceRepo) => {
      const first = providerInstanceRepo.create({
        provider: "local-file",
        name: "Local file A",
        config: '{"path":"/tmp/a.json"}',
      });
      const second = providerInstanceRepo.create({
        provider: "local-file",
        name: "Local file B",
      });

      expect(first.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(second.config).toBe("{}");
      expect(providerInstanceRepo.list()).toEqual([first, second]);
      expect(providerInstanceRepo.get(first.id)).toEqual(first);

      expect(providerInstanceRepo.delete(first.id)).toBe(true);
      expect(providerInstanceRepo.get(first.id)).toBeUndefined();
      expect(providerInstanceRepo.delete(first.id)).toBe(false);
    });
  });

  it("refuses to delete a provider instance that is in use", () => {
    withRepos((providerInstanceRepo, projectRepo, projectPath) => {
      mkdirSync(projectPath);
      const providerInstance = providerInstanceRepo.create({
        provider: "local-file",
        name: "Shared local file",
      });

      projectRepo.create({
        path: projectPath,
        providerInstanceId: providerInstance.id,
      });

      expect(() => {
        providerInstanceRepo.delete(providerInstance.id);
      }).toThrow(DEnvError);
      expect(providerInstanceRepo.get(providerInstance.id)).toEqual(
        providerInstance,
      );
    });
  });

  it("rejects empty provider and name values", () => {
    withRepos((providerInstanceRepo) => {
      expect(() => {
        providerInstanceRepo.create({
          provider: "",
          name: "Local file",
        });
      }).toThrow(DEnvError);

      expect(() => {
        providerInstanceRepo.create({
          provider: "local-file",
          name: "   ",
        });
      }).toThrow(DEnvError);
    });
  });
});
