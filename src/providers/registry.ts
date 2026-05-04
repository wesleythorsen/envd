import type { Provider } from "./base.js";
import localFileProvider from "./local-file/index.js";

export const providers: readonly Provider[] = [localFileProvider];

export function findProvider(name: string): Provider | undefined {
  return providers.find((provider) => provider.name === name);
}
