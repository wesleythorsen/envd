import type { Database } from "better-sqlite3";
import { DEnvError } from "../shared/errors.js";

export type StagedDesiredMap = Readonly<Record<string, string | null>>;

export interface StagingRepoOptions {
  readonly now?: () => number;
}

interface StagingRow {
  desired: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidStoredDesired(): DEnvError {
  return new DEnvError("stored staging desired state is invalid", {
    code: "internal",
  });
}

function parseDesired(raw: string): StagedDesiredMap {
  // as-cast justified: staging.desired is a JSON serialization boundary.
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw invalidStoredDesired();
  }

  const desired: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" && value !== null) {
      throw invalidStoredDesired();
    }
    desired[key] = value;
  }

  return desired;
}

export class StagingRepo {
  private readonly db: Database;
  private readonly now: () => number;

  constructor(db: Database, opts: StagingRepoOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
  }

  getDesired(projectId: string): StagedDesiredMap | undefined {
    const row = this.db
      .prepare<[string], StagingRow>(
        `
        SELECT desired
        FROM staging
        WHERE project_id = ?
      `,
      )
      .get(projectId);

    return row === undefined ? undefined : parseDesired(row.desired);
  }

  setDesired(projectId: string, map: StagedDesiredMap): void {
    this.db
      .prepare(
        `
        INSERT INTO staging (project_id, updated_at, desired)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          desired = excluded.desired
      `,
      )
      .run(projectId, this.now(), JSON.stringify(map));
  }

  clear(projectId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM staging WHERE project_id = ?")
      .run(projectId);
    return result.changes > 0;
  }
}
