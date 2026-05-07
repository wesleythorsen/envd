import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectRepo } from "../../src/core/project.js";
import { openState, type StateStore } from "../../src/core/state.js";
import {
  createEncryptedStagingCodec,
  StagingRepo,
  type StagingRepoOptions,
} from "../../src/core/staging.js";

interface StoredRow {
  desired: string;
  desired_version: number;
}

function withRepo(
  fn: (repo: StagingRepo, projectId: string, store: StateStore) => void,
  opts: StagingRepoOptions = {},
): void {
  const dir = mkdtempSync(join(tmpdir(), "envd-staging-test-"));
  const dbPath = join(dir, "state.db");
  const projectPath = join(dir, "project");
  const store = openState(dbPath);

  try {
    mkdirSync(projectPath);
    const project = new ProjectRepo(store.db).create({ path: projectPath });

    fn(
      new StagingRepo(store.db, { now: () => 1234, ...opts }),
      project.id,
      store,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function readStoredRow(store: StateStore, projectId: string): StoredRow {
  const row = store.db
    .prepare<
      [string],
      StoredRow
    >("SELECT desired, desired_version FROM staging WHERE project_id = ?")
    .get(projectId);
  if (row === undefined) {
    throw new Error("expected staging row");
  }
  return row;
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

  it("keeps staged desired state scoped by environment", () => {
    withRepo((repo, projectId) => {
      repo.setDesired(projectId, { API_KEY: "dev" }, "dev");
      repo.setDesired(projectId, { API_KEY: "stage" }, "stage");

      expect(repo.getDesired(projectId)).toBeUndefined();
      expect(repo.getDesired(projectId, "dev")).toEqual({ API_KEY: "dev" });
      expect(repo.getDesired(projectId, "stage")).toEqual({
        API_KEY: "stage",
      });

      expect(repo.clear(projectId, "dev")).toBe(true);
      expect(repo.getDesired(projectId, "dev")).toBeUndefined();
      expect(repo.getDesired(projectId, "stage")).toEqual({
        API_KEY: "stage",
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

  it("encrypts desired state when a codec is configured", () => {
    withRepo(
      (repo, projectId, store) => {
        repo.setDesired(projectId, {
          API_KEY: "secret",
        });

        const row = readStoredRow(store, projectId);
        expect(row.desired_version).toBe(1);
        expect(row.desired).not.toContain("secret");
        expect(repo.getDesired(projectId)).toEqual({
          API_KEY: "secret",
        });
      },
      {
        codec: createEncryptedStagingCodec(Buffer.alloc(32, 9), {
          randomBytes: () => Buffer.alloc(12, 1),
        }),
      },
    );
  });

  it("reencrypts legacy plaintext rows when encryption is enabled later", () => {
    withRepo((plainRepo, projectId, store) => {
      plainRepo.setDesired(projectId, {
        API_KEY: "secret",
      });

      const encryptedRepo = new StagingRepo(store.db, {
        codec: createEncryptedStagingCodec(Buffer.alloc(32, 4), {
          randomBytes: () => Buffer.alloc(12, 2),
        }),
      });
      expect(encryptedRepo.reencryptLegacyRows()).toBe(1);

      const row = readStoredRow(store, projectId);
      expect(row.desired_version).toBe(1);
      expect(row.desired).not.toContain("secret");
      expect(encryptedRepo.getDesired(projectId)).toEqual({
        API_KEY: "secret",
      });
    });
  });

  it("fails loudly when encrypted staging rows are tampered with", () => {
    withRepo(
      (repo, projectId, store) => {
        repo.setDesired(projectId, {
          API_KEY: "secret",
        });

        const row = readStoredRow(store, projectId);
        const payload = JSON.parse(row.desired) as Record<string, string>;
        payload["authTag"] = "AAAA";
        store.db
          .prepare("UPDATE staging SET desired = ? WHERE project_id = ?")
          .run(JSON.stringify(payload), projectId);

        expect(() => {
          repo.getDesired(projectId);
        }).toThrowError(/could not be decrypted/);
      },
      {
        codec: createEncryptedStagingCodec(Buffer.alloc(32, 5), {
          randomBytes: () => Buffer.alloc(12, 3),
        }),
      },
    );
  });
});
