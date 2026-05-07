import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyEnvFileName,
  discoverEnvFiles,
} from "../../src/cli/env-file-discovery.js";

function withTempProject(
  fn: (projectDir: string) => void | Promise<void>,
): Promise<void> {
  const projectDir = mkdtempSync(join(tmpdir(), "envd-env-discovery-"));
  return Promise.resolve(fn(projectDir)).finally(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

describe("env file discovery", () => {
  it("classifies common env filename conventions", () => {
    expect(classifyEnvFileName(".env")).toMatchObject({
      environment: "default",
      confidence: "high",
      ambiguous: false,
    });
    expect(classifyEnvFileName(".env.dev")).toMatchObject({
      environment: "dev",
      confidence: "high",
    });
    expect(classifyEnvFileName(".dev.env")).toMatchObject({
      environment: "dev",
      confidence: "high",
    });
    expect(classifyEnvFileName("development.env")).toMatchObject({
      environment: "dev",
      confidence: "high",
    });
    expect(classifyEnvFileName(".env.local")).toMatchObject({
      environment: "local",
      confidence: "medium",
      ambiguous: true,
    });
    expect(classifyEnvFileName(".env.example")).toBeNull();
  });

  it("scans common env locations and ignores dependency, build, and git directories", async () => {
    await withTempProject((projectDir) => {
      write(join(projectDir, ".env.dev"), "A=1\n");
      write(join(projectDir, "env", "stage.env"), "B=2\n");
      write(join(projectDir, "config", "nested", ".env.prod"), "C=3\n");
      write(join(projectDir, "node_modules", ".env.test"), "IGNORED=1\n");
      write(join(projectDir, ".git", ".env.test"), "IGNORED=1\n");
      write(join(projectDir, "dist", ".env.test"), "IGNORED=1\n");
      write(join(projectDir, "src", ".env.test"), "IGNORED=1\n");

      const result = discoverEnvFiles(projectDir);

      expect(result.parseErrors).toEqual([]);
      expect(result.files.map((file) => file.relativePath)).toEqual([
        ".env.dev",
        "config/nested/.env.prod",
        "env/stage.env",
      ]);
      expect(
        result.files.map((file) => file.classification.environment),
      ).toEqual(["dev", "prod", "stage"]);
      expect(result.files.map((file) => file.keyCount)).toEqual([1, 1, 1]);
    });
  });

  it("supports repeated explicit scan paths", async () => {
    await withTempProject((projectDir) => {
      write(join(projectDir, "packages", "api", ".env.test"), "API=1\n");
      write(join(projectDir, "apps", "web", "web.env"), "WEB=1\n");

      const result = discoverEnvFiles(projectDir, {
        scanPaths: ["packages/api", "apps/web"],
      });

      expect(result.files.map((file) => file.relativePath)).toEqual([
        "apps/web/web.env",
        "packages/api/.env.test",
      ]);
    });
  });

  it("reports file-specific parse errors", async () => {
    await withTempProject((projectDir) => {
      write(join(projectDir, ".env.dev"), "GOOD=1\n");
      write(join(projectDir, "env", "stage.env"), "BROKEN\n");

      const result = discoverEnvFiles(projectDir);

      expect(result.files.map((file) => file.relativePath)).toEqual([
        ".env.dev",
      ]);
      expect(result.parseErrors).toHaveLength(1);
      expect(result.parseErrors[0]).toMatchObject({
        relativePath: "env/stage.env",
        message: "dotenv line must contain '='",
      });
    });
  });

  it("detects duplicate environment mappings and conflicting values", async () => {
    await withTempProject((projectDir) => {
      write(join(projectDir, ".env.dev"), "SHARED=one\nONLY_A=1\n");
      write(
        join(projectDir, "env", "development.env"),
        "SHARED=two\nONLY_B=2\n",
      );
      write(join(projectDir, "config", ".env.stage"), "SAME=value\n");
      write(join(projectDir, "env", "stage.env"), "SAME=value\n");

      const result = discoverEnvFiles(projectDir);

      expect(result.duplicates).toEqual([
        {
          environment: "dev",
          files: [
            join(projectDir, ".env.dev"),
            join(projectDir, "env", "development.env"),
          ],
          conflictingKeys: ["SHARED"],
        },
        {
          environment: "stage",
          files: [
            join(projectDir, "config", ".env.stage"),
            join(projectDir, "env", "stage.env"),
          ],
          conflictingKeys: [],
        },
      ]);
    });
  });
});
