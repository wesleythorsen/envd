import { createLogger, type Logger } from "../shared/logger.js";
import type { KeychainAdapter } from "./base.js";

function mapKey(service: string, account: string): string {
  return `${service}\0${account}`;
}

export class InMemoryKeychainAdapter implements KeychainAdapter {
  private readonly logger: Logger;
  private readonly secrets = new Map<string, string>();

  constructor(logger: Logger = createLogger("providers/keychain")) {
    this.logger = logger;
    this.logger.warn({
      msg: "TODO US-5.1: in-memory keychain stores credentials only for this daemon process",
    });
  }

  set(service: string, account: string, secret: string): Promise<void> {
    this.secrets.set(mapKey(service, account), secret);
    return Promise.resolve();
  }

  get(service: string, account: string): Promise<string | null> {
    return Promise.resolve(this.secrets.get(mapKey(service, account)) ?? null);
  }

  delete(service: string, account: string): Promise<void> {
    this.secrets.delete(mapKey(service, account));
    return Promise.resolve();
  }
}
