import { createRequire } from "node:module";
import type { Database } from "better-sqlite3";
import { migrations, type Migration } from "./migrations/index.js";

interface SqliteFactory {
  new (filename: string): Database;
}

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as SqliteFactory;

export interface StateStore {
  readonly db: Database;
  close(): void;
}

interface MigrationRow {
  id: string;
}

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function appliedMigrationIds(db: Database): Set<string> {
  ensureMigrationsTable(db);
  const rows = db
    .prepare<[], MigrationRow>("SELECT id FROM _migrations ORDER BY id")
    .all();
  return new Set(rows.map((row) => row.id));
}

function applyMigration(db: Database, migration: Migration): void {
  const run = db.transaction(() => {
    migration.up(db);
    db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)").run(
      migration.id,
      Date.now(),
    );
  });
  run();
}

function runMigrations(db: Database): void {
  const applied = appliedMigrationIds(db);
  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      applyMigration(db, migration);
      applied.add(migration.id);
    }
  }
}

export function openState(path: string): StateStore {
  const db = new BetterSqlite3(path);
  runMigrations(db);

  return {
    db,
    close() {
      db.close();
    },
  };
}
