import type { Migration } from "./types.js";

export const migration: Migration = {
  id: "0005_staging_encryption",
  up(db) {
    db.exec(`
      ALTER TABLE staging
      ADD COLUMN desired_version INTEGER NOT NULL DEFAULT 0
    `);
  },
};
