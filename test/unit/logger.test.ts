import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type LogData } from "../../src/shared/logger.js";

function captureStderr(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("");
}

describe("JSON format (D_ENV_LOG_FORMAT=json)", () => {
  beforeEach(() => {
    process.env["D_ENV_LOG_FORMAT"] = "json";
    process.env["D_ENV_LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    delete process.env["D_ENV_LOG_FORMAT"];
    delete process.env["D_ENV_LOG_LEVEL"];
  });

  it("emits a valid JSON object per log call", () => {
    const logger = createLogger("test-scope");
    const out = captureStderr(() => logger.info({ msg: "hello" }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parsed: Record<string, unknown> = JSON.parse(out.trim());
    expect(parsed["level"]).toBe("info");
    expect(parsed["scope"]).toBe("test-scope");
    expect(parsed["msg"]).toBe("hello");
    expect(typeof parsed["ts"]).toBe("string");
  });

  it("includes data field when provided", () => {
    const logger = createLogger("test-scope");
    const out = captureStderr(() =>
      logger.debug({ msg: "with data", data: { key: "value", count: 3 } }),
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parsed: Record<string, unknown> = JSON.parse(out.trim());
    expect(parsed["data"]).toEqual({ key: "value", count: 3 });
  });

  it("omits data field when not provided", () => {
    const logger = createLogger("test-scope");
    const out = captureStderr(() => logger.warn({ msg: "no data" }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parsed: Record<string, unknown> = JSON.parse(out.trim());
    expect("data" in parsed).toBe(false);
  });

  it("each level produces the correct level field", () => {
    const logger = createLogger("s");
    for (const level of ["debug", "info", "warn", "error"] as const) {
      const out = captureStderr(() => logger[level]({ msg: "m" }));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const parsed: Record<string, unknown> = JSON.parse(out.trim());
      expect(parsed["level"]).toBe(level);
    }
  });
});

describe("Human format (default)", () => {
  beforeEach(() => {
    delete process.env["D_ENV_LOG_FORMAT"];
    process.env["D_ENV_LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    delete process.env["D_ENV_LOG_LEVEL"];
  });

  it("emits a readable line with scope and message", () => {
    const logger = createLogger("my-scope");
    const out = captureStderr(() => logger.info({ msg: "starting up" }));
    expect(out).toContain("my-scope");
    expect(out).toContain("starting up");
    expect(out).toContain("INFO");
  });

  it("includes key=value pairs for data", () => {
    const logger = createLogger("s");
    const out = captureStderr(() =>
      logger.info({ msg: "m", data: { port: 1910, ready: true } }),
    );
    expect(out).toContain("port=1910");
    expect(out).toContain("ready=true");
  });

  it("does not emit JSON syntax", () => {
    const logger = createLogger("s");
    const out = captureStderr(() => logger.info({ msg: "m" }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    expect(() => JSON.parse(out.trim())).toThrow();
  });
});

describe("Level filtering", () => {
  afterEach(() => {
    delete process.env["D_ENV_LOG_LEVEL"];
    delete process.env["D_ENV_LOG_FORMAT"];
  });

  it("suppresses debug when level=info (default)", () => {
    delete process.env["D_ENV_LOG_LEVEL"];
    const logger = createLogger("s");
    const out = captureStderr(() => logger.debug({ msg: "quiet" }));
    expect(out).toBe("");
  });

  it("emits info when level=info", () => {
    process.env["D_ENV_LOG_LEVEL"] = "info";
    const logger = createLogger("s");
    const out = captureStderr(() => logger.info({ msg: "visible" }));
    expect(out).toContain("visible");
  });

  it("suppresses info when level=warn", () => {
    process.env["D_ENV_LOG_LEVEL"] = "warn";
    const logger = createLogger("s");
    const out = captureStderr(() => logger.info({ msg: "suppressed" }));
    expect(out).toBe("");
  });

  it("emits warn when level=warn", () => {
    process.env["D_ENV_LOG_LEVEL"] = "warn";
    const logger = createLogger("s");
    const out = captureStderr(() => logger.warn({ msg: "shown" }));
    expect(out).toContain("shown");
  });

  it("suppresses warn when level=error", () => {
    process.env["D_ENV_LOG_LEVEL"] = "error";
    const logger = createLogger("s");
    const out = captureStderr(() => logger.warn({ msg: "hidden" }));
    expect(out).toBe("");
  });

  it("emits error at all levels", () => {
    for (const lvl of ["debug", "info", "warn", "error"] as const) {
      process.env["D_ENV_LOG_LEVEL"] = lvl;
      const logger = createLogger("s");
      const out = captureStderr(() => logger.error({ msg: "always" }));
      expect(out).toContain("always");
    }
  });

  it("unknown D_ENV_LOG_LEVEL falls back to info", () => {
    process.env["D_ENV_LOG_LEVEL"] = "verbose";
    const logger = createLogger("s");
    const debugOut = captureStderr(() => logger.debug({ msg: "quiet" }));
    const infoOut = captureStderr(() => logger.info({ msg: "shown" }));
    expect(debugOut).toBe("");
    expect(infoOut).toContain("shown");
  });
});

describe("Data type guard (redaction guardrail)", () => {
  it("accepts the narrow LogData shape", () => {
    // This must compile without error. The LogData type is verified at compile time.
    const good: LogData = {
      str: "hello",
      num: 42,
      bool: true,
      nil: null,
    };
    const logger = createLogger("s");
    // If this call compiles, the type is accepted.
    const out = captureStderr(() => logger.info({ msg: "typed", data: good }));
    expect(out).not.toBe("");
  });

  it("rejects an object typed outside the allowed data shape", () => {
    // The logger's data field is LogData = Record<string, string|number|boolean|null>.
    // Passing a nested object must be a TypeScript error. The @ts-expect-error below
    // asserts that TS rejects this call — if TS ever accepts it, the test fails to compile.
    const logger = createLogger("s");
    // @ts-expect-error — nested object violates LogData's narrow type; secrets can't slip through.
    logger.info({ msg: "bad", data: { nested: { secret: "hunter2" } } });
  });
});
