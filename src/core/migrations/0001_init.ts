import type { Migration } from "./types.js";

export const migration: Migration = {
  id: "0001_init",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
  },
};
