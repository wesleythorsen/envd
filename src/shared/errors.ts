export const ERROR_CODES = [
  "daemon_unreachable",
  "usage_error",
  "provider_unreachable",
  "provider_auth",
  "commit_conflict",
  "mount_failed",
  "not_initialized",
  "internal",
  "bad_dotenv",
  "unauthorized",
  "not_found",
  "method_not_allowed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class EnvdError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    opts: {
      code: ErrorCode;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = "EnvdError";
    this.code = opts.code;
    if (opts.details !== undefined) {
      this.details = opts.details;
    }
  }
}
