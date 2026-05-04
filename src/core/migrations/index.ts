import type { Migration } from "./types.js";
import { migration as init } from "./0001_init.js";
import { migration as projects } from "./0002_projects.js";
import { migration as providerInstances } from "./0003_provider_instances.js";
import { migration as staging } from "./0004_staging.js";

export const migrations: readonly Migration[] = [
  init,
  projects,
  providerInstances,
  staging,
];

export type { Migration } from "./types.js";
