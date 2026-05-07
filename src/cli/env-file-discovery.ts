import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parse as parseDotenv } from "../core/rendering/dotenv.js";
import type { SecretMap } from "../providers/base.js";
import { EnvdError } from "../shared/errors.js";

export type EnvFileConfidence = "high" | "medium" | "low";

export interface EnvFileClassification {
  readonly environment: string;
  readonly confidence: EnvFileConfidence;
  readonly ambiguous: boolean;
  readonly reasons: readonly string[];
}

export interface DiscoveredEnvFile {
  readonly path: string;
  readonly relativePath: string;
  readonly classification: EnvFileClassification;
  readonly keyCount: number;
  readonly keys: readonly string[];
}

export interface EnvFileParseError {
  readonly path: string;
  readonly relativePath: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface EnvFileDuplicateMapping {
  readonly environment: string;
  readonly files: readonly string[];
  readonly conflictingKeys: readonly string[];
}

export interface EnvFileDiscoveryResult {
  readonly files: readonly DiscoveredEnvFile[];
  readonly parseErrors: readonly EnvFileParseError[];
  readonly duplicates: readonly EnvFileDuplicateMapping[];
}

export interface EnvFileDiscoveryOptions {
  readonly scanPaths?: readonly string[];
}

interface ScanRoot {
  readonly path: string;
  readonly maxDepth: number;
}

interface ParsedEnvFile {
  readonly file: DiscoveredEnvFile;
  readonly values: SecretMap;
}

const DEFAULT_ENVIRONMENT = "default";
const COMMON_ENV_DIRS = [
  "config",
  "configs",
  "env",
  "envs",
  "environments",
  ".config",
] as const;
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".vite",
  ".venv",
  "vendor",
]);
const NON_SECRET_TEMPLATES = new Set([
  "example",
  "examples",
  "sample",
  "samples",
  "template",
  "templates",
]);
const ENVIRONMENT_ALIASES = new Map<string, string>([
  ["development", "dev"],
  ["staging", "stage"],
  ["production", "prod"],
  ["testing", "test"],
]);

function normalizeEnvironment(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "" || NON_SECRET_TEMPLATES.has(normalized)) {
    return null;
  }
  return ENVIRONMENT_ALIASES.get(normalized) ?? normalized;
}

function classification(
  environment: string,
  confidence: EnvFileConfidence,
  ...reasons: readonly string[]
): EnvFileClassification {
  return {
    environment,
    confidence,
    ambiguous: confidence !== "high",
    reasons,
  };
}

export function classifyEnvFileName(
  fileNameOrPath: string,
): EnvFileClassification | null {
  const name = basename(fileNameOrPath);

  if (name === ".env") {
    return classification(DEFAULT_ENVIRONMENT, "high", "default dotenv file");
  }

  const envPrefixMatch = /^\.env\.([A-Za-z0-9_-]+)(?:\.local)?$/.exec(name);
  if (envPrefixMatch !== null) {
    const rawEnvironment = envPrefixMatch[1];
    if (rawEnvironment === undefined) {
      return null;
    }
    const environment = normalizeEnvironment(rawEnvironment);
    if (environment === null) {
      return null;
    }
    return classification(
      environment,
      name.endsWith(".local") ? "medium" : "high",
      name.endsWith(".local")
        ? "framework local override dotenv file"
        : "environment suffix dotenv file",
    );
  }

  const envSuffixMatch = /^\.?([A-Za-z0-9_-]+)\.env(?:\.local)?$/.exec(name);
  if (envSuffixMatch !== null) {
    const rawEnvironment = envSuffixMatch[1];
    if (rawEnvironment === undefined) {
      return null;
    }
    const environment = normalizeEnvironment(rawEnvironment);
    if (environment === null) {
      return null;
    }
    return classification(
      environment,
      name.endsWith(".local") ? "medium" : "high",
      name.endsWith(".local")
        ? "framework local override dotenv file"
        : "environment prefix dotenv file",
    );
  }

  return null;
}

function defaultScanRoots(projectDir: string): readonly ScanRoot[] {
  return [
    { path: projectDir, maxDepth: 0 },
    ...COMMON_ENV_DIRS.map((dir) => ({
      path: join(projectDir, dir),
      maxDepth: 2,
    })),
  ];
}

function explicitScanRoots(
  projectDir: string,
  scanPaths: readonly string[],
): readonly ScanRoot[] {
  return scanPaths.map((scanPath) => ({
    path: resolve(projectDir, scanPath),
    maxDepth: Number.POSITIVE_INFINITY,
  }));
}

function relativeToProject(projectDir: string, path: string): string {
  const rel = relative(projectDir, path);
  return rel === "" ? "." : rel;
}

function shouldIgnoreDir(entry: Dirent): boolean {
  return entry.isDirectory() && IGNORE_DIRS.has(entry.name);
}

function collectCandidateFiles(
  root: ScanRoot,
  candidates: Set<string>,
  depth = 0,
): void {
  if (!existsSync(root.path)) {
    return;
  }

  const stats = statSync(root.path);
  if (stats.isFile()) {
    if (classifyEnvFileName(root.path) !== null) {
      candidates.add(root.path);
    }
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(root.path, { withFileTypes: true })) {
    const path = join(root.path, entry.name);
    if (entry.isFile()) {
      if (classifyEnvFileName(entry.name) !== null) {
        candidates.add(path);
      }
      continue;
    }
    if (
      depth < root.maxDepth &&
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      !shouldIgnoreDir(entry)
    ) {
      collectCandidateFiles(
        { path, maxDepth: root.maxDepth },
        candidates,
        depth + 1,
      );
    }
  }
}

function parseError(
  projectDir: string,
  path: string,
  err: unknown,
): EnvFileParseError {
  const base = {
    path,
    relativePath: relativeToProject(projectDir, path),
    message: err instanceof Error ? err.message : String(err),
  };
  return err instanceof EnvdError && err.details !== undefined
    ? { ...base, details: err.details }
    : base;
}

function discoverParsedFiles(
  projectDir: string,
  paths: readonly string[],
): {
  readonly parsed: readonly ParsedEnvFile[];
  readonly parseErrors: readonly EnvFileParseError[];
} {
  const parsed: ParsedEnvFile[] = [];
  const parseErrors: EnvFileParseError[] = [];

  for (const path of paths) {
    const classification = classifyEnvFileName(path);
    if (classification === null) {
      continue;
    }

    try {
      const values = parseDotenv(readFileSync(path));
      const keys = Object.keys(values).sort();
      parsed.push({
        values,
        file: {
          path,
          relativePath: relativeToProject(projectDir, path),
          classification,
          keyCount: keys.length,
          keys,
        },
      });
    } catch (err: unknown) {
      parseErrors.push(parseError(projectDir, path, err));
    }
  }

  return { parsed, parseErrors };
}

function duplicateMappings(
  parsed: readonly ParsedEnvFile[],
): readonly EnvFileDuplicateMapping[] {
  const byEnvironment = new Map<string, ParsedEnvFile[]>();
  for (const file of parsed) {
    const existing = byEnvironment.get(file.file.classification.environment);
    if (existing === undefined) {
      byEnvironment.set(file.file.classification.environment, [file]);
    } else {
      existing.push(file);
    }
  }

  const duplicates: EnvFileDuplicateMapping[] = [];
  for (const [environment, files] of byEnvironment) {
    if (files.length < 2) {
      continue;
    }

    const conflictingKeys = new Set<string>();
    const valuesByKey = new Map<string, string>();
    for (const file of files) {
      for (const [key, value] of Object.entries(file.values)) {
        const existing = valuesByKey.get(key);
        if (existing === undefined) {
          valuesByKey.set(key, value);
        } else if (existing !== value) {
          conflictingKeys.add(key);
        }
      }
    }

    duplicates.push({
      environment,
      files: files.map((file) => file.file.path).sort(),
      conflictingKeys: [...conflictingKeys].sort(),
    });
  }

  return duplicates.sort((a, b) => a.environment.localeCompare(b.environment));
}

export function discoverEnvFiles(
  projectDir: string,
  options: EnvFileDiscoveryOptions = {},
): EnvFileDiscoveryResult {
  const candidatePaths = new Set<string>();
  const roots = [
    ...defaultScanRoots(projectDir),
    ...explicitScanRoots(projectDir, options.scanPaths ?? []),
  ];

  for (const root of roots) {
    collectCandidateFiles(root, candidatePaths);
  }

  const paths = [...candidatePaths].sort();
  const { parsed, parseErrors } = discoverParsedFiles(projectDir, paths);

  return {
    files: parsed.map((file) => file.file),
    parseErrors,
    duplicates: duplicateMappings(parsed),
  };
}
