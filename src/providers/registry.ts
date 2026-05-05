import type { Provider } from "./base.js";
import awsSecretsManagerProvider from "./aws-secrets-manager/index.js";
import bitwardenSecretManagerProvider from "./bitwarden-secret-manager/index.js";
import dopplerProvider from "./doppler/index.js";
import localFileProvider from "./local-file/index.js";

export const providers: readonly Provider[] = [
  localFileProvider,
  dopplerProvider,
  bitwardenSecretManagerProvider,
  awsSecretsManagerProvider,
];

export function findProvider(name: string): Provider | undefined {
  return providers.find((provider) => provider.name === name);
}
