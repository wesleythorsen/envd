import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { EnvdError } from "../shared/errors.js";

export interface ProviderInstanceRecord {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly config: string;
  readonly createdAt: number;
}

export interface CreateProviderInstanceInput {
  readonly provider: string;
  readonly name: string;
  readonly config?: string;
}

interface ProviderInstanceRow {
  id: string;
  provider: string;
  name: string;
  config: string;
  created_at: number;
}

interface CountRow {
  count: number;
}

function rowToProviderInstance(
  row: ProviderInstanceRow,
): ProviderInstanceRecord {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    config: row.config,
    createdAt: row.created_at,
  };
}

function validateNonEmpty(value: string, field: "provider" | "name"): string {
  if (value.trim() === "") {
    throw new EnvdError(`${field} must be a non-empty string`, {
      code: "usage_error",
    });
  }
  return value;
}

export class ProviderInstanceRepo {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: CreateProviderInstanceInput): ProviderInstanceRecord {
    const now = Date.now();
    const providerInstance: ProviderInstanceRecord = {
      id: randomUUID(),
      provider: validateNonEmpty(input.provider, "provider"),
      name: validateNonEmpty(input.name, "name"),
      config: input.config ?? "{}",
      createdAt: now,
    };

    const existing = this.db
      .prepare<[string], ProviderInstanceRow>(
        `
        SELECT id, provider, name, config, created_at
        FROM provider_instances
        WHERE name = ?
      `,
      )
      .get(providerInstance.name);
    if (existing !== undefined) {
      throw new EnvdError("provider instance name already exists", {
        code: "usage_error",
        details: { name: providerInstance.name },
      });
    }

    this.db
      .prepare(
        `
        INSERT INTO provider_instances (
          id, provider, name, config, created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        providerInstance.id,
        providerInstance.provider,
        providerInstance.name,
        providerInstance.config,
        providerInstance.createdAt,
      );

    return providerInstance;
  }

  get(id: string): ProviderInstanceRecord | undefined {
    const row = this.db
      .prepare<[string], ProviderInstanceRow>(
        `
        SELECT id, provider, name, config, created_at
        FROM provider_instances
        WHERE id = ?
      `,
      )
      .get(id);
    return row === undefined ? undefined : rowToProviderInstance(row);
  }

  list(): readonly ProviderInstanceRecord[] {
    return this.db
      .prepare<[], ProviderInstanceRow>(
        `
        SELECT id, provider, name, config, created_at
        FROM provider_instances
        ORDER BY rowid ASC
      `,
      )
      .all()
      .map(rowToProviderInstance);
  }

  delete(id: string): boolean {
    const projectCount = this.db
      .prepare<[string], CountRow>(
        `
        SELECT COUNT(*) AS count
        FROM projects
        WHERE provider_instance_id = ?
      `,
      )
      .get(id);

    if ((projectCount?.count ?? 0) > 0) {
      throw new EnvdError("provider instance is in use by a project", {
        code: "usage_error",
        details: { providerInstanceId: id },
      });
    }

    const result = this.db
      .prepare("DELETE FROM provider_instances WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
