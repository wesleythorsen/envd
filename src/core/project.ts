import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";
import { EnvdError } from "../shared/errors.js";

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
  readonly activeEnvironment: string;
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
  readonly activeEnvironment?: string;
}

interface ProjectRow {
  id: string;
  token: string;
  path: string;
  provider_instance_id: string | null;
  active_environment: string;
  format: string;
  format_config: string;
  created_at: number;
  updated_at: number;
}

export interface ProjectEnvironment {
  readonly projectId: string;
  readonly name: string;
  readonly providerEnvironment: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ProjectEnvironmentRow {
  project_id: string;
  name: string;
  provider_environment: string;
  created_at: number;
  updated_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    token: row.token,
    path: row.path,
    providerInstanceId: row.provider_instance_id,
    activeEnvironment: row.active_environment,
    format: row.format,
    formatConfig: row.format_config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProjectEnvironment(
  row: ProjectEnvironmentRow,
): ProjectEnvironment {
  return {
    projectId: row.project_id,
    name: row.name,
    providerEnvironment: row.provider_environment,
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
      throw new EnvdError("project path must be absolute", {
        code: "usage_error",
        details: { path: input.path },
      });
    }

    if (!existsSync(input.path)) {
      throw new EnvdError("project path does not exist", {
        code: "usage_error",
        details: { path: input.path },
      });
    }

    const providerInstanceId = input.providerInstanceId ?? null;
    if (providerInstanceId !== null && providerInstanceId.trim() === "") {
      throw new EnvdError("providerInstanceId must be a non-empty string", {
        code: "usage_error",
      });
    }
    if (
      providerInstanceId !== null &&
      !providerInstanceExists(this.db, providerInstanceId)
    ) {
      throw new EnvdError("provider instance does not exist", {
        code: "usage_error",
        details: { providerInstanceId },
      });
    }

    const now = Date.now();
    const activeEnvironment = input.activeEnvironment ?? "default";
    if (activeEnvironment.trim() === "") {
      throw new EnvdError("activeEnvironment must be a non-empty string", {
        code: "usage_error",
      });
    }

    const project: Project = {
      id: randomUUID(),
      token: randomBytes(32).toString("hex"),
      path: input.path,
      providerInstanceId,
      activeEnvironment,
      format: input.format ?? "dotenv",
      formatConfig: input.formatConfig ?? DEFAULT_FORMAT_CONFIG,
      createdAt: now,
      updatedAt: now,
    };

    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO projects (
            id, token, path, provider_instance_id, active_environment, format, format_config, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          project.id,
          project.token,
          project.path,
          project.providerInstanceId,
          project.activeEnvironment,
          project.format,
          project.formatConfig,
          project.createdAt,
          project.updatedAt,
        );

      this.createEnvironmentRow(project.id, activeEnvironment, now);
    });
    create();

    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db
      .prepare<[string], ProjectRow>(
        `
        SELECT id, token, path, provider_instance_id, active_environment, format, format_config, created_at, updated_at
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
        SELECT id, token, path, provider_instance_id, active_environment, format, format_config, created_at, updated_at
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

  listEnvironments(projectId: string): readonly ProjectEnvironment[] {
    return this.db
      .prepare<[string], ProjectEnvironmentRow>(
        `
        SELECT project_id, name, provider_environment, created_at, updated_at
        FROM project_environments
        WHERE project_id = ?
        ORDER BY name ASC
      `,
      )
      .all(projectId)
      .map(rowToProjectEnvironment);
  }

  getEnvironment(
    projectId: string,
    name: string,
  ): ProjectEnvironment | undefined {
    const row = this.db
      .prepare<[string, string], ProjectEnvironmentRow>(
        `
        SELECT project_id, name, provider_environment, created_at, updated_at
        FROM project_environments
        WHERE project_id = ? AND name = ?
      `,
      )
      .get(projectId, name);
    return row === undefined ? undefined : rowToProjectEnvironment(row);
  }

  createEnvironment(
    projectId: string,
    name: string,
    providerEnvironment = name,
  ): ProjectEnvironment {
    if (this.get(projectId) === undefined) {
      throw new EnvdError("project does not exist", {
        code: "not_found",
        details: { projectId },
      });
    }
    if (name.trim() === "" || providerEnvironment.trim() === "") {
      throw new EnvdError("environment names must be non-empty", {
        code: "usage_error",
      });
    }
    const now = Date.now();
    this.createEnvironmentRow(projectId, name, now, providerEnvironment);
    const created = this.getEnvironment(projectId, name);
    if (created === undefined) {
      throw new EnvdError("environment was not created", { code: "internal" });
    }
    return created;
  }

  setActiveEnvironment(projectId: string, name: string): Project {
    if (this.getEnvironment(projectId, name) === undefined) {
      throw new EnvdError("environment does not exist", {
        code: "not_found",
        details: { projectId, environment: name },
      });
    }
    this.db
      .prepare(
        `
        UPDATE projects
        SET active_environment = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(name, Date.now(), projectId);
    const updated = this.get(projectId);
    if (updated === undefined) {
      throw new EnvdError("project does not exist", {
        code: "not_found",
        details: { projectId },
      });
    }
    return updated;
  }

  private createEnvironmentRow(
    projectId: string,
    name: string,
    now: number,
    providerEnvironment = name,
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO project_environments (
          project_id, name, provider_environment, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(projectId, name, providerEnvironment, now, now);
  }
}
