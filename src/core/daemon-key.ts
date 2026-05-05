import { randomBytes as nodeRandomBytes } from "node:crypto";
import { EnvdError } from "../shared/errors.js";
import { DAEMON_KEY_SERVICE_NAME } from "../shared/product.js";
import type { KeychainAdapter } from "./keychain.js";

const DAEMON_KEY_ACCOUNT = "staging-encryption-key";

type RandomBytes = (size: number) => Buffer;

export interface DaemonKeyOptions {
  readonly mustExist?: boolean;
  readonly randomBytes?: RandomBytes;
}

function parseStoredKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new EnvdError("daemon encryption key is invalid", {
      code: "internal",
    });
  }
  return key;
}

export async function loadOrCreateDaemonKey(
  keychain: KeychainAdapter,
  opts: DaemonKeyOptions = {},
): Promise<Buffer> {
  const existing = await keychain.get(
    DAEMON_KEY_SERVICE_NAME,
    DAEMON_KEY_ACCOUNT,
  );
  if (existing !== null) {
    return parseStoredKey(existing);
  }

  if (opts.mustExist === true) {
    throw new EnvdError(
      "daemon encryption key is missing; cannot decrypt staged data",
      {
        code: "internal",
      },
    );
  }

  const key = (opts.randomBytes ?? nodeRandomBytes)(32);
  await keychain.set(
    DAEMON_KEY_SERVICE_NAME,
    DAEMON_KEY_ACCOUNT,
    key.toString("base64"),
  );
  return key;
}
