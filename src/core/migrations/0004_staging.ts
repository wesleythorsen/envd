import type { Migration } from "./types.js";

export const migration: Migration = {
  id: "0004_staging",
  up(db) {
    db.exec(`
      CREATE TABLE staging (
        project_id TEXT NOT NULL PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        updated_at INTEGER NOT NULL,
        desired TEXT NOT NULL
      )
    `);
  },
};
