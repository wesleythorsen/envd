import type { Migration } from "./types.js";

export const migration: Migration = {
  id: "0002_projects",
  up(db) {
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        path TEXT NOT NULL,
        format TEXT NOT NULL,
        format_config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    db.exec("CREATE UNIQUE INDEX projects_path_idx ON projects(path)");
  },
};
