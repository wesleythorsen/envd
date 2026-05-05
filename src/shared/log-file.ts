import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface RotatingFileLogSinkOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

function rotatedPath(path: string, index: number): string {
  return index === 0 ? path : `${path}.${index}`;
}

export class RotatingFileLogSink {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(path: string, opts: RotatingFileLogSinkOptions = {}) {
    this.path = path;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, opts.maxFiles ?? 5);
  }

  write(line: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
  }

  private rotateIfNeeded(incomingBytes: number): void {
    const currentSize = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentSize + incomingBytes <= this.maxBytes) {
      return;
    }

    rmSync(rotatedPath(this.path, this.maxFiles - 1), { force: true });
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      const source = rotatedPath(this.path, index);
      if (!existsSync(source)) {
        continue;
      }
      renameSync(source, rotatedPath(this.path, index + 1));
    }
    if (existsSync(this.path)) {
      renameSync(this.path, rotatedPath(this.path, 1));
    }
    writeFileSync(this.path, "", { encoding: "utf8", mode: 0o600 });
  }
}

export function readLogTail(
  path: string,
  lines: number,
  opts: RotatingFileLogSinkOptions = {},
): readonly string[] {
  if (!Number.isFinite(lines) || lines <= 0) {
    return [];
  }

  const maxFiles = Math.max(1, opts.maxFiles ?? 5);
  const collected: string[] = [];
  for (let index = maxFiles - 1; index >= 0; index -= 1) {
    const currentPath = rotatedPath(path, index);
    if (!existsSync(currentPath)) {
      continue;
    }
    const raw = readFileSync(currentPath, "utf8");
    if (raw === "") {
      continue;
    }
    const split = raw.split("\n");
    if (split.at(-1) === "") {
      split.pop();
    }
    for (const line of split) {
      collected.push(`${line}\n`);
    }
  }

  return collected.slice(-lines);
}
