import type { Provider } from "./base.js";

export const providers: readonly Provider[] = [];

export function findProvider(name: string): Provider | undefined {
  return providers.find((provider) => provider.name === name);
}
