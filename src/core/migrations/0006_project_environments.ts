import type { Migration } from "./types.js";

export const migration: Migration = {
  id: "0006_project_environments",
  up(db) {
    db.exec(`
      ALTER TABLE projects
      ADD COLUMN active_environment TEXT NOT NULL DEFAULT 'default'
    `);

    db.exec(`
      CREATE TABLE project_environments (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        provider_environment TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, name)
      )
    `);

    db.exec(`
      INSERT OR IGNORE INTO project_environments (
        project_id, name, provider_environment, created_at, updated_at
      )
      SELECT id, 'default', 'default', created_at, updated_at
      FROM projects
    `);
  },
};
