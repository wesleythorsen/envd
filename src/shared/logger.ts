/** Structured logger for d-env. JSON-per-line on D_ENV_LOG_FORMAT=json; concise human output otherwise. */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Allowed value types in the structured data field — deliberately narrow to prevent accidental secret logging. */
export type LogData = Record<string, string | number | boolean | null>;

export interface LogEntry {
  msg: string;
  data?: LogData;
}

export interface Logger {
  debug(entry: LogEntry): void;
  info(entry: LogEntry): void;
  warn(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLevel(): LogLevel {
  const raw = process.env["D_ENV_LOG_LEVEL"];
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function resolveFormat(): "json" | "human" {
  return process.env["D_ENV_LOG_FORMAT"] === "json" ? "json" : "human";
}

/** Creates a logger bound to a scope string (e.g. "daemon", "cli/init"). */
export function createLogger(scope: string): Logger {
  function emit(level: LogLevel, entry: LogEntry): void {
    const minLevel = LEVELS[resolveLevel()];
    if (LEVELS[level] < minLevel) return;

    if (resolveFormat() === "json") {
      const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        scope,
        msg: entry.msg,
      };
      if (entry.data !== undefined) {
        line["data"] = entry.data;
      }
      process.stderr.write(JSON.stringify(line) + "\n");
    } else {
      const dataStr =
        entry.data !== undefined && Object.keys(entry.data).length > 0
          ? " " +
            Object.entries(entry.data)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(" ")
          : "";
      process.stderr.write(
        `[${level.toUpperCase()}] ${scope}: ${entry.msg}${dataStr}\n`,
      );
    }
  }

  return {
    debug: (entry) => {
      emit("debug", entry);
    },
    info: (entry) => {
      emit("info", entry);
    },
    warn: (entry) => {
      emit("warn", entry);
    },
    error: (entry) => {
      emit("error", entry);
    },
  };
}
