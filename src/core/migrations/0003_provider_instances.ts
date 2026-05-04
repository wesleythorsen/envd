import type { Migration } from "./types.js";

export const migration: Migration = {
  id: "0003_provider_instances",
  up(db) {
    db.exec(`
      CREATE TABLE provider_instances (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      ALTER TABLE projects
      ADD COLUMN provider_instance_id TEXT REFERENCES provider_instances(id)
    `);
  },
};
