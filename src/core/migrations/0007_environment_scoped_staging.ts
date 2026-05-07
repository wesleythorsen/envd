import type { Migration } from "./types.js";

export const migration: Migration = {
  id: "0007_environment_scoped_staging",
  up(db) {
    db.exec(`
      CREATE TABLE staging_next (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment TEXT NOT NULL DEFAULT 'default',
        updated_at INTEGER NOT NULL,
        desired TEXT NOT NULL,
        desired_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, environment)
      )
    `);

    db.exec(`
      INSERT INTO staging_next (
        project_id, environment, updated_at, desired, desired_version
      )
      SELECT project_id, 'default', updated_at, desired, desired_version
      FROM staging
    `);

    db.exec("DROP TABLE staging");
    db.exec("ALTER TABLE staging_next RENAME TO staging");
  },
};
