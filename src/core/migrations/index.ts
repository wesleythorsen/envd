import type { Migration } from "./types.js";
import { migration as init } from "./0001_init.js";
import { migration as projects } from "./0002_projects.js";
import { migration as providerInstances } from "./0003_provider_instances.js";
import { migration as staging } from "./0004_staging.js";
import { migration as stagingEncryption } from "./0005_staging_encryption.js";
import { migration as projectEnvironments } from "./0006_project_environments.js";
import { migration as environmentScopedStaging } from "./0007_environment_scoped_staging.js";

export const migrations: readonly Migration[] = [
  init,
  projects,
  providerInstances,
  staging,
  stagingEncryption,
  projectEnvironments,
  environmentScopedStaging,
];

export type { Migration } from "./types.js";
