/** Structured logger for envd. JSON-per-line on ENVD_LOG_FORMAT=json; concise human output otherwise. */
import { LOG_FORMAT_ENV_VAR, LOG_LEVEL_ENV_VAR } from "./product.js";

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

type LogWriter = (line: string) => void;
type LogSubscriber = (line: string) => void;

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const subscribers = new Set<LogSubscriber>();
let writeLine: LogWriter = (line) => {
  process.stderr.write(line);
};

function resolveLevel(): LogLevel {
  const raw = process.env[LOG_LEVEL_ENV_VAR];
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function resolveFormat(): "json" | "human" {
  return process.env[LOG_FORMAT_ENV_VAR] === "json" ? "json" : "human";
}

export function setLogWriter(writer: LogWriter): void {
  writeLine = writer;
}

export function resetLogWriter(): void {
  writeLine = (line) => {
    process.stderr.write(line);
  };
}

export function subscribeLogLines(listener: LogSubscriber): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
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
      const rendered = JSON.stringify(line) + "\n";
      writeLine(rendered);
      for (const subscriber of subscribers) {
        subscriber(rendered);
      }
    } else {
      const dataStr =
        entry.data !== undefined && Object.keys(entry.data).length > 0
          ? " " +
            Object.entries(entry.data)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(" ")
          : "";
      const rendered = `[${level.toUpperCase()}] ${scope}: ${entry.msg}${dataStr}\n`;
      writeLine(rendered);
      for (const subscriber of subscribers) {
        subscriber(rendered);
      }
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
