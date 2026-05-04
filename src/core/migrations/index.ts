import type { Migration } from "./types.js";
import { migration as init } from "./0001_init.js";
import { migration as projects } from "./0002_projects.js";

export const migrations: readonly Migration[] = [init, projects];

export type { Migration } from "./types.js";
