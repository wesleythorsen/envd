import { DEnvError } from "../shared/errors.js";
import type { MountAdapter } from "./adapter.js";

/**
 * Returns the correct `MountAdapter` for the current platform.
 *
 * Only darwin is implemented in US-1.2. A Linux adapter is planned for US-8.3.
 * Any other platform (including Linux for now) throws a `DEnvError` with
 * `code: "mount_failed"`.
 */
export async function createMountAdapter(): Promise<MountAdapter> {
  const platform = process.platform;

  if (platform === "darwin") {
    // Dynamic import keeps Linux/Windows code off the darwin path entirely.
    const { DarwinMountAdapter } = await import("./darwin.js");
    return new DarwinMountAdapter();
  }

  if (platform === "linux") {
    const { LinuxMountAdapter } = await import("./linux.js");
    return new LinuxMountAdapter();
  }

  throw new DEnvError(
    `Mount adapter not implemented for platform "${platform}"`,
    {
      code: "mount_failed",
      details: { platform },
    },
  );
}

export type { MountAdapter } from "./adapter.js";
