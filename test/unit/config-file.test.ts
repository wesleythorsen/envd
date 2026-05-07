import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  editConfig,
  findProjectRegistration,
  migrateLegacyProjectFile,
  parseEnvdConfig,
  readEnvdConfig,
  registerProject,
  resolveProjectRoot,
  serializeEnvdConfig,
} from "../../src/cli/config-file.js";

function withTempHome(
  fn: (home: string) => void | Promise<void>,
): Promise<void> {
  const dir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "envd-config-test-")),
  );
  const previousHome = process.env["ENVD_HOME"];
  process.env["ENVD_HOME"] = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (previousHome === undefined) {
      delete process.env["ENVD_HOME"];
    } else {
      process.env["ENVD_HOME"] = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("envd TOML config", () => {
  it("round-trips project and provider registrations", () => {
    const config = {
      schemaVersion: 1 as const,
      providerInstances: [
        { id: "provider-1", name: "personal", provider: "local-file" },
      ],
      projects: [
        {
          id: "project-1",
          root: "/tmp/project",
          providerInstanceId: "provider-1",
          providerProject: "project",
          activeEnvironment: "dev",
          environments: [
            { name: "dev", providerEnvironment: "dev" },
            { name: "stage", providerEnvironment: "stg" },
          ],
        },
      ],
    };

    expect(parseEnvdConfig(serializeEnvdConfig(config))).toEqual(config);
  });

  it("registers and resolves projects by git root", async () => {
    await withTempHome((home) => {
      const repo = join(home, "repo");
      const nested = join(repo, "packages", "app");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(nested, { recursive: true });

      registerProject({
        id: "project-1",
        root: resolveProjectRoot(nested),
        activeEnvironment: "default",
        environments: [{ name: "default", providerEnvironment: "default" }],
      });

      expect(findProjectRegistration(nested)?.id).toBe("project-1");
      expect(readEnvdConfig().projects[0]?.root).toBe(repo);
    });
  });

  it("migrates legacy .envd.json into TOML and retires the file", async () => {
    await withTempHome((home) => {
      const repo = join(home, "repo");
      mkdirSync(repo);
      writeFileSync(
        join(repo, ".envd.json"),
        JSON.stringify({ projectId: "project-1", version: 1 }),
      );

      const migrated = migrateLegacyProjectFile(repo);

      expect(migrated?.projectId).toBe("project-1");
      expect(existsSync(join(repo, ".envd.json"))).toBe(false);
      expect(existsSync(join(repo, ".envd.json.retired"))).toBe(true);
      expect(readEnvdConfig().projects[0]?.id).toBe("project-1");
    });
  });

  it("restores the previous config when edited TOML fails validation", async () => {
    await withTempHome((home) => {
      const path = join(home, "config.toml");
      writeFileSync(path, "schema_version = 1\n", "utf-8");

      expect(() =>
        editConfig(path, {
          editor: "fake-editor",
          runEditor: (_editor, file) => {
            writeFileSync(file, "schema_version = 2\n", "utf-8");
            return 0;
          },
        }),
      ).toThrow("config schema_version must be 1");
      expect(readFileSync(path, "utf-8")).toBe("schema_version = 1\n");
    });
  });
});
