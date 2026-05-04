import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEnvError } from "../shared/errors.js";

export const PROJECT_FILE = ".d-env.json";
export const ENV_FILE = ".env";

export interface ProjectFile {
  readonly projectId: string;
  readonly version: 1;
}

export function parseProjectFile(path: string): ProjectFile {
  const raw = readFileSync(path, "utf-8");
  // as-cast justified: .d-env.json is an external serialization boundary.
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed["projectId"] !== "string" || parsed["version"] !== 1) {
    throw new DEnvError(".d-env.json is malformed", {
      code: "usage_error",
      details: { path },
    });
  }
  return { projectId: parsed["projectId"], version: 1 };
}

export function writeProjectFile(projectDir: string, projectId: string): void {
  const path = join(projectDir, PROJECT_FILE);
  const body = JSON.stringify({ projectId, version: 1 }, null, 2) + "\n";
  writeFileSync(path, body, { encoding: "utf-8", flag: "wx" });
}

export function ensureGitignore(projectDir: string): void {
  const path = join(projectDir, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, `${ENV_FILE}\n`, "utf-8");
    return;
  }

  const raw = readFileSync(path, "utf-8");
  const hasEnv = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ENV_FILE);
  if (!hasEnv) {
    const prefix = raw === "" || raw.endsWith("\n") ? "" : "\n";
    appendFileSync(path, `${prefix}${ENV_FILE}\n`, "utf-8");
  }
}

export function isDEnvSymlink(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const target = readlinkSync(path);
    return target.includes("/p/") && target.endsWith("/.env");
  } catch {
    return false;
  }
}

export function ensureEnvSymlink(projectDir: string, target: string): void {
  const envPath = join(projectDir, ENV_FILE);
  try {
    const stat = lstatSync(envPath);
    if (!stat.isSymbolicLink()) {
      throw new DEnvError(".env exists and is not a symlink", {
        code: "usage_error",
        details: { path: envPath },
      });
    }
    if (!isDEnvSymlink(envPath)) {
      throw new DEnvError(".env symlink is not managed by d-env", {
        code: "usage_error",
        details: { path: envPath },
      });
    }
    unlinkSync(envPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  symlinkSync(target, envPath);
}

export function removeEnvSymlink(projectDir: string): boolean {
  const envPath = join(projectDir, ENV_FILE);
  try {
    const stat = lstatSync(envPath);
    if (!stat.isSymbolicLink()) {
      throw new DEnvError(".env exists and is not a symlink", {
        code: "usage_error",
        details: { path: envPath },
      });
    }
    if (!isDEnvSymlink(envPath)) {
      throw new DEnvError(".env symlink is not managed by d-env", {
        code: "usage_error",
        details: { path: envPath },
      });
    }
    unlinkSync(envPath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
