import { TextDecoder, TextEncoder } from "node:util";
import type { SecretMap } from "../../providers/base.js";
import { DEnvError } from "../../shared/errors.js";

export type DotenvQuoteMode = "always" | "when-needed";
export type DotenvSortKeys = "alphabetical" | "insertion";

export interface DotenvOptions {
  readonly quote?: DotenvQuoteMode;
  readonly sortKeys?: DotenvSortKeys;
}

type DotenvOptionsInput = DotenvOptions | Readonly<Record<string, unknown>>;

interface NormalizedDotenvOptions {
  readonly quote: DotenvQuoteMode;
  readonly sortKeys: DotenvSortKeys;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const validKey = /^[A-Za-z0-9_.-]+$/u;

function badDotenv(message: string, details?: Record<string, unknown>): never {
  if (details === undefined) {
    throw new DEnvError(message, { code: "bad_dotenv" });
  }

  throw new DEnvError(message, { code: "bad_dotenv", details });
}

function normalizeOptions(
  opts: DotenvOptionsInput = {},
): NormalizedDotenvOptions {
  const rawOptions = opts as Readonly<Record<string, unknown>>;
  const quote = rawOptions["quote"] ?? "when-needed";
  const sortKeys = rawOptions["sortKeys"] ?? "alphabetical";

  if (quote !== "always" && quote !== "when-needed") {
    badDotenv("invalid dotenv quote option");
  }

  if (sortKeys !== "alphabetical" && sortKeys !== "insertion") {
    badDotenv("invalid dotenv sortKeys option");
  }

  return { quote, sortKeys };
}

function assertValidKey(key: string, line?: number): void {
  if (!validKey.test(key)) {
    badDotenv("invalid dotenv key", {
      key,
      ...(line === undefined ? {} : { line }),
    });
  }
}

function decode(bytes: Uint8Array): string {
  try {
    const text = decoder.decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (err) {
    throw new DEnvError("dotenv bytes must be valid UTF-8", {
      code: "bad_dotenv",
      cause: err,
    });
  }
}

function parseSingleQuoted(source: string, line: number): string {
  const closeIndex = source.indexOf("'", 1);

  if (closeIndex === -1) {
    badDotenv("unterminated single-quoted dotenv value", { line });
  }

  if (source.slice(closeIndex + 1).trim().length > 0) {
    badDotenv("unexpected text after single-quoted dotenv value", { line });
  }

  return source.slice(1, closeIndex);
}

function parseDoubleQuoted(source: string, line: number): string {
  let value = "";
  let escaped = false;

  for (let index = 1; index < source.length; index += 1) {
    const char = source[index];

    if (char === undefined) {
      break;
    }

    if (escaped) {
      switch (char) {
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "\\":
          value += "\\";
          break;
        case '"':
          value += '"';
          break;
        default:
          badDotenv("unsupported escape in double-quoted dotenv value", {
            line,
          });
      }

      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      if (source.slice(index + 1).trim().length > 0) {
        badDotenv("unexpected text after double-quoted dotenv value", { line });
      }

      return value;
    }

    value += char;
  }

  badDotenv("unterminated double-quoted dotenv value", { line });
}

function parseValue(source: string, line: number): string {
  if (source.startsWith("'")) {
    return parseSingleQuoted(source, line);
  }

  if (source.startsWith('"')) {
    return parseDoubleQuoted(source, line);
  }

  return source;
}

function setParsedValue(
  parsed: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(parsed, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function parse(bytes: Uint8Array, opts?: DotenvOptions): SecretMap;
export function parse(
  bytes: Uint8Array,
  opts?: Readonly<Record<string, unknown>>,
): SecretMap;
export function parse(
  bytes: Uint8Array,
  opts: DotenvOptionsInput = {},
): SecretMap {
  normalizeOptions(opts);

  const parsed: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = decode(bytes)
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n");

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    const candidate = line.trimStart();

    if (candidate.length === 0 || candidate.startsWith("#")) {
      continue;
    }

    const separatorIndex = candidate.indexOf("=");
    if (separatorIndex === -1) {
      badDotenv("dotenv line must contain '='", { line: lineNumber });
    }

    const key = candidate.slice(0, separatorIndex).trim();
    if (key.length === 0) {
      badDotenv("dotenv key must not be empty", { line: lineNumber });
    }
    assertValidKey(key, lineNumber);

    if (seen.has(key)) {
      badDotenv("duplicate dotenv key", { key, line: lineNumber });
    }
    seen.add(key);

    setParsedValue(
      parsed,
      key,
      parseValue(candidate.slice(separatorIndex + 1).trimStart(), lineNumber),
    );
  }

  return parsed;
}

function sortedKeys(map: SecretMap, sortKeys: DotenvSortKeys): string[] {
  const keys = Object.keys(map);
  return sortKeys === "alphabetical" ? keys.sort() : keys;
}

function needsQuote(value: string): boolean {
  return /[\s#"'\\]/u.test(value);
}

function doubleQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"');

  return `"${escaped}"`;
}

function renderValue(value: string, quote: DotenvQuoteMode): string {
  if (quote === "always" || needsQuote(value)) {
    return doubleQuote(value);
  }

  return value;
}

export function render(map: SecretMap, opts?: DotenvOptions): Uint8Array;
export function render(
  map: SecretMap,
  opts?: Readonly<Record<string, unknown>>,
): Uint8Array;
export function render(
  map: SecretMap,
  opts: DotenvOptionsInput = {},
): Uint8Array {
  const options = normalizeOptions(opts);
  const lines: string[] = [];

  for (const key of sortedKeys(map, options.sortKeys)) {
    assertValidKey(key);
    const value = map[key];

    if (typeof value !== "string") {
      badDotenv("dotenv values must be strings", { key });
    }

    lines.push(`${key}=${renderValue(value, options.quote)}`);
  }

  return encoder.encode(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}
