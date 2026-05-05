import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import type { Database } from "better-sqlite3";
import { EnvdError } from "../shared/errors.js";

export type StagedDesiredMap = Readonly<Record<string, string | null>>;

export interface StagingCodec {
  readonly version: number;
  encode(map: StagedDesiredMap): string;
  decode(raw: string): StagedDesiredMap;
}

export interface StagingRepoOptions {
  readonly now?: () => number;
  readonly codec?: StagingCodec;
}

interface StagingRow {
  desired: string;
  desired_version: number;
}

interface LegacyStagingRow {
  project_id: string;
  desired: string;
}

interface EncryptedPayload {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

interface EncryptedStagingCodecOptions {
  readonly randomBytes?: (size: number) => Buffer;
}

const PLAIN_DESIRED_VERSION = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidStoredDesired(
  message = "stored staging desired state is invalid",
): EnvdError {
  return new EnvdError(message, {
    code: "internal",
  });
}

function decryptFailure(cause: unknown): EnvdError {
  return new EnvdError("stored staging desired state could not be decrypted", {
    code: "internal",
    cause,
  });
}

function serializeDesired(map: StagedDesiredMap): string {
  return JSON.stringify(map);
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

function parseEncryptedPayload(value: unknown): EncryptedPayload {
  if (!isRecord(value)) {
    throw new Error("encrypted staging payload must be an object");
  }

  const version = value["version"];
  const algorithm = value["algorithm"];
  const iv = value["iv"];
  const authTag = value["authTag"];
  const ciphertext = value["ciphertext"];
  if (
    version !== 1 ||
    algorithm !== "aes-256-gcm" ||
    typeof iv !== "string" ||
    typeof authTag !== "string" ||
    typeof ciphertext !== "string"
  ) {
    throw new Error("encrypted staging payload has an unsupported shape");
  }

  return { version, algorithm, iv, authTag, ciphertext };
}

export function createEncryptedStagingCodec(
  key: Buffer,
  opts: EncryptedStagingCodecOptions = {},
): StagingCodec {
  if (key.length !== 32) {
    throw invalidStoredDesired("staging encryption key must be 32 bytes");
  }

  const randomBytes = opts.randomBytes ?? nodeRandomBytes;

  return {
    version: 1,
    encode(map) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(serializeDesired(map), "utf8"),
        cipher.final(),
      ]);
      const payload: EncryptedPayload = {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      return JSON.stringify(payload);
    },
    decode(raw) {
      try {
        const payload = parseEncryptedPayload(JSON.parse(raw));
        const decipher = createDecipheriv(
          payload.algorithm,
          key,
          Buffer.from(payload.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(payload.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
        return parseDesired(plaintext);
      } catch (error: unknown) {
        throw decryptFailure(error);
      }
    },
  };
}

export class StagingRepo {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly codec: StagingCodec | undefined;

  constructor(db: Database, opts: StagingRepoOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.codec = opts.codec;
  }

  getDesired(projectId: string): StagedDesiredMap | undefined {
    const row = this.db
      .prepare<[string], StagingRow>(
        `
        SELECT desired, desired_version
        FROM staging
        WHERE project_id = ?
      `,
      )
      .get(projectId);

    if (row === undefined) {
      return undefined;
    }
    if (row.desired_version === PLAIN_DESIRED_VERSION) {
      return parseDesired(row.desired);
    }
    if (
      this.codec === undefined ||
      row.desired_version !== this.codec.version
    ) {
      throw invalidStoredDesired(
        "stored staging desired state has an unsupported version",
      );
    }
    return this.codec.decode(row.desired);
  }

  setDesired(projectId: string, map: StagedDesiredMap): void {
    const desired = this.codec?.encode(map) ?? serializeDesired(map);
    const desiredVersion = this.codec?.version ?? PLAIN_DESIRED_VERSION;
    this.db
      .prepare(
        `
        INSERT INTO staging (project_id, updated_at, desired, desired_version)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          desired = excluded.desired,
          desired_version = excluded.desired_version
      `,
      )
      .run(projectId, this.now(), desired, desiredVersion);
  }

  hasEncryptedRows(): boolean {
    const row = this.db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) AS count FROM staging WHERE desired_version > 0")
      .get();
    return (row?.count ?? 0) > 0;
  }

  reencryptLegacyRows(): number {
    if (
      this.codec === undefined ||
      this.codec.version === PLAIN_DESIRED_VERSION
    ) {
      return 0;
    }

    const rows = this.db
      .prepare<[], LegacyStagingRow>(
        `
        SELECT project_id, desired
        FROM staging
        WHERE desired_version = 0
      `,
      )
      .all();
    if (rows.length === 0) {
      return 0;
    }

    const rewrite = this.db.transaction(
      (legacyRows: readonly LegacyStagingRow[]) => {
        const update = this.db.prepare(
          `
            UPDATE staging
            SET desired = ?, desired_version = ?
            WHERE project_id = ?
          `,
        );
        for (const row of legacyRows) {
          update.run(
            this.codec?.encode(parseDesired(row.desired)),
            this.codec?.version,
            row.project_id,
          );
        }
      },
    );
    rewrite(rows);
    return rows.length;
  }

  clear(projectId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM staging WHERE project_id = ?")
      .run(projectId);
    return result.changes > 0;
  }
}
