import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readLogTail,
  RotatingFileLogSink,
} from "../../src/shared/log-file.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "d-env-log-file-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("RotatingFileLogSink", () => {
  afterEach(() => {
    delete process.env["D_ENV_HOME"];
  });

  it("rotates once the active file would exceed the size limit", () => {
    withTempDir((dir) => {
      const path = join(dir, "d-envd.log");
      const sink = new RotatingFileLogSink(path, {
        maxBytes: 12,
        maxFiles: 3,
      });

      sink.write("alpha\n");
      sink.write("bravo\n");
      sink.write("charlie\n");
      sink.write("delta\n");

      expect(readFileSync(path, "utf8")).toBe("delta\n");
      expect(readFileSync(`${path}.1`, "utf8")).toBe("charlie\n");
      expect(readFileSync(`${path}.2`, "utf8")).toBe("alpha\nbravo\n");
      expect(existsSync(`${path}.3`)).toBe(false);
    });
  });

  it("reads a tail across rotated files in chronological order", () => {
    withTempDir((dir) => {
      const path = join(dir, "d-envd.log");
      const sink = new RotatingFileLogSink(path, {
        maxBytes: 12,
        maxFiles: 3,
      });

      sink.write("alpha\n");
      sink.write("bravo\n");
      sink.write("charlie\n");
      sink.write("delta\n");

      expect(readLogTail(path, 3, { maxFiles: 3 })).toEqual([
        "bravo\n",
        "charlie\n",
        "delta\n",
      ]);
    });
  });

  it("returns an empty tail for missing files or non-positive requests", () => {
    withTempDir((dir) => {
      const path = join(dir, "missing.log");

      expect(readLogTail(path, 0)).toEqual([]);
      expect(readLogTail(path, -1)).toEqual([]);
      expect(readLogTail(path, 5)).toEqual([]);
    });
  });
});
