import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openState } from "../../src/core/state.js";

function withTempDb(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "envd-state-test-"));
  try {
    fn(join(dir, "state.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface CountRow {
  count: number;
}

describe("openState", () => {
  it("applies migrations to a fresh database", () => {
    withTempDb((dbPath) => {
      const store = openState(dbPath);
      try {
        const row = store.db
          .prepare<
            [],
            CountRow
          >("SELECT COUNT(*) AS count FROM _migrations WHERE id = ?")
          .get("0001_init");

        expect(row?.count).toBe(1);
      } finally {
        store.close();
      }
    });
  });

  it("does not reapply migrations when reopened", () => {
    withTempDb((dbPath) => {
      const first = openState(dbPath);
      first.close();

      const second = openState(dbPath);
      try {
        const row = second.db
          .prepare<[], CountRow>("SELECT COUNT(*) AS count FROM _migrations")
          .get();

        expect(row?.count).toBe(7);
      } finally {
        second.close();
      }
    });
  });

  it("adds the provider_instances table and project foreign-key column", () => {
    withTempDb((dbPath) => {
      const store = openState(dbPath);
      try {
        const tableRow = store.db
          .prepare<
            [],
            CountRow
          >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'provider_instances'")
          .get();
        const columnRows = store.db
          .prepare<[], { name: string }>("PRAGMA table_info(projects)")
          .all();

        expect(tableRow?.count).toBe(1);
        expect(columnRows.map((column) => column.name)).toContain(
          "provider_instance_id",
        );
      } finally {
        store.close();
      }
    });
  });

  it("adds the staging table", () => {
    withTempDb((dbPath) => {
      const store = openState(dbPath);
      try {
        const tableRow = store.db
          .prepare<
            [],
            CountRow
          >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'staging'")
          .get();
        const columnRows = store.db
          .prepare<
            [],
            { name: string; type: string; notnull: number; pk: number }
          >("PRAGMA table_info(staging)")
          .all();

        expect(tableRow?.count).toBe(1);
        expect(
          columnRows.map((column) => ({
            name: column.name,
            type: column.type,
            notnull: column.notnull,
            pk: column.pk,
          })),
        ).toEqual([
          { name: "project_id", type: "TEXT", notnull: 1, pk: 1 },
          { name: "environment", type: "TEXT", notnull: 1, pk: 2 },
          { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "desired", type: "TEXT", notnull: 1, pk: 0 },
          { name: "desired_version", type: "INTEGER", notnull: 1, pk: 0 },
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("rolls back a migration transaction on failure", () => {
    withTempDb((dbPath) => {
      const store = openState(dbPath);
      try {
        const migration = store.db.transaction(() => {
          store.db.exec("CREATE TABLE rollback_probe (id TEXT PRIMARY KEY)");
          throw new Error("boom");
        });

        expect(() => {
          migration();
        }).toThrow("boom");

        const row = store.db
          .prepare<
            [],
            CountRow
          >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'")
          .get();

        expect(row?.count).toBe(0);
      } finally {
        store.close();
      }
    });
  });
});
