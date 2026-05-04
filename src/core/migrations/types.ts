import type { Database } from "better-sqlite3";

export interface Migration {
  readonly id: string;
  up(db: Database): void;
}
