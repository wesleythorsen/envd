import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import { DEnvError } from "../shared/errors.js";

const DEFAULT_FORMAT_CONFIG = JSON.stringify({
  quote: "when-needed",
  sortKeys: "alphabetical",
});
const MISSING_PROJECT_TOKEN = "0".repeat(64);

export interface Project {
  readonly id: string;
  readonly token: string;
  readonly path: string;
  readonly providerInstanceId: string | null;
  readonly format: string;
  readonly formatConfig: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateProjectInput {
  readonly path: string;
  readonly providerInstanceId?: string;
  readonly format?: string;
  readonly formatConfig?: string;
}

interface ProjectRow {
  id: string;
  token: string;
  path: string;
  provider_instance_id: string | null;
  format: string;
  format_config: string;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    token: row.token,
    path: row.path,
    providerInstanceId: row.provider_instance_id,
    format: row.format,
    formatConfig: row.format_config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerInstanceExists(db: Database, id: string): boolean {
  const row = db
    .prepare<
      [string],
      { id: string }
    >("SELECT id FROM provider_instances WHERE id = ?")
    .get(id);
  return row !== undefined;
}

function tokensEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf-8");
  const bBuffer = Buffer.from(b, "utf-8");
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

export class ProjectRepo {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: CreateProjectInput): Project {
    if (!isAbsolute(input.path)) {
      throw new DEnvError("project path must be absolute", {
        code: "usage_error",
        details: { path: input.path },
      });
    }

    if (!existsSync(input.path)) {
      throw new DEnvError("project path does not exist", {
        code: "usage_error",
        details: { path: input.path },
      });
    }

    const providerInstanceId = input.providerInstanceId ?? null;
    if (providerInstanceId !== null && providerInstanceId.trim() === "") {
      throw new DEnvError("providerInstanceId must be a non-empty string", {
        code: "usage_error",
      });
    }
    if (
      providerInstanceId !== null &&
      !providerInstanceExists(this.db, providerInstanceId)
    ) {
      throw new DEnvError("provider instance does not exist", {
        code: "usage_error",
        details: { providerInstanceId },
      });
    }

    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      token: randomBytes(32).toString("hex"),
      path: input.path,
      providerInstanceId,
      format: input.format ?? "dotenv",
      formatConfig: input.formatConfig ?? DEFAULT_FORMAT_CONFIG,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `
        INSERT INTO projects (
          id, token, path, provider_instance_id, format, format_config, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        project.id,
        project.token,
        project.path,
        project.providerInstanceId,
        project.format,
        project.formatConfig,
        project.createdAt,
        project.updatedAt,
      );

    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db
      .prepare<[string], ProjectRow>(
        `
        SELECT id, token, path, provider_instance_id, format, format_config, created_at, updated_at
        FROM projects
        WHERE id = ?
      `,
      )
      .get(id);
    return row === undefined ? undefined : rowToProject(row);
  }

  getByToken(id: string, token: string): Project | undefined {
    const project = this.get(id);
    const candidateToken = project?.token ?? MISSING_PROJECT_TOKEN;
    return project !== undefined && tokensEqual(candidateToken, token)
      ? project
      : undefined;
  }

  list(): readonly Project[] {
    return this.db
      .prepare<[], ProjectRow>(
        `
        SELECT id, token, path, provider_instance_id, format, format_config, created_at, updated_at
        FROM projects
        ORDER BY rowid ASC
      `,
      )
      .all()
      .map(rowToProject);
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
